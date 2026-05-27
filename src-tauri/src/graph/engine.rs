use super::types::{ExecutionMode, ExecutionPlan, NodeConfig};
use crate::pty::{
    manager::{PtyManager, PtyTask},
    providers::{ProviderConfig, ProviderDisplayMode, load_provider_configs},
};
use crate::review::{HumanReviewDecision, HumanReviewRegistry};
use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize)]
pub struct GraphNodePayload {
    pub run_id: String,
    pub node_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GraphCompletePayload {
    pub run_id: String,
    pub completed_nodes: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GraphErrorPayload {
    pub run_id: String,
    pub node_id: Option<String>,
    pub error: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct HumanReviewRequest {
    pub run_id: String,
    pub node_id: String,
    pub prompt: String,
    pub upstream: Vec<HumanReviewUpstream>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HumanReviewUpstream {
    pub node_id: String,
    pub result: String,
}

pub fn execute_plan_background(
    app: AppHandle,
    pty_manager: PtyManager,
    review_registry: HumanReviewRegistry,
    run_id: String,
    plan: ExecutionPlan,
) {
    thread::spawn(move || {
        if let Err(error) = execute_plan(&app, pty_manager, review_registry, &run_id, plan) {
            let _ = app.emit(
                "graph:error",
                GraphErrorPayload {
                    run_id,
                    node_id: None,
                    error,
                },
            );
        }
    });
}

pub fn topological_batches(plan: &ExecutionPlan) -> Result<Vec<Vec<NodeConfig>>, String> {
    if plan.nodes.is_empty() {
        return Err("execution plan has no nodes".to_string());
    }

    if plan.mode == ExecutionMode::Sequential {
        return Ok(plan
            .nodes
            .iter()
            .cloned()
            .map(|node| vec![node])
            .collect::<Vec<_>>());
    }

    let nodes_by_id = plan
        .nodes
        .iter()
        .cloned()
        .map(|node| (node.id.clone(), node))
        .collect::<HashMap<_, _>>();
    if nodes_by_id.len() != plan.nodes.len() {
        return Err("execution plan contains duplicate node ids".to_string());
    }

    let mut incoming = nodes_by_id
        .keys()
        .map(|id| (id.clone(), 0_usize))
        .collect::<HashMap<_, _>>();
    let mut outgoing = nodes_by_id
        .keys()
        .map(|id| (id.clone(), Vec::<String>::new()))
        .collect::<HashMap<_, _>>();

    for edge in &plan.edges {
        if !nodes_by_id.contains_key(&edge.from) {
            return Err(format!(
                "edge references unknown source node: {}",
                edge.from
            ));
        }
        if !nodes_by_id.contains_key(&edge.to) {
            return Err(format!("edge references unknown target node: {}", edge.to));
        }
        outgoing
            .get_mut(&edge.from)
            .expect("source node is pre-populated")
            .push(edge.to.clone());
        *incoming
            .get_mut(&edge.to)
            .expect("target node is pre-populated") += 1;
    }

    let mut ready = incoming
        .iter()
        .filter_map(|(id, count)| (*count == 0).then_some(id.clone()))
        .collect::<VecDeque<_>>();
    let mut visited = 0_usize;
    let mut batches = Vec::new();

    while !ready.is_empty() {
        let mut batch_ids = Vec::new();
        while let Some(id) = ready.pop_front() {
            batch_ids.push(id);
        }

        let mut batch = Vec::new();
        for id in &batch_ids {
            visited += 1;
            batch.push(nodes_by_id.get(id).expect("ready node exists").clone());

            for target in outgoing.get(id).expect("ready node has outgoing list") {
                let target_count = incoming
                    .get_mut(target)
                    .expect("target node is pre-populated");
                *target_count -= 1;
                if *target_count == 0 {
                    ready.push_back(target.clone());
                }
            }
        }

        batches.push(batch);
    }

    if visited != nodes_by_id.len() {
        return Err("execution plan contains a cycle".to_string());
    }

    Ok(batches)
}

fn upstream_map(plan: &ExecutionPlan) -> HashMap<String, Vec<String>> {
    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    for edge in &plan.edges {
        map.entry(edge.to.clone())
            .or_default()
            .push(edge.from.clone());
    }
    map
}

fn execute_plan(
    app: &AppHandle,
    pty_manager: PtyManager,
    review_registry: HumanReviewRegistry,
    run_id: &str,
    plan: ExecutionPlan,
) -> Result<(), String> {
    let providers = load_provider_configs()?
        .into_iter()
        .map(|provider| (provider.name.clone(), provider))
        .collect::<HashMap<_, _>>();
    let upstream = Arc::new(upstream_map(&plan));
    let outputs: Arc<Mutex<HashMap<String, String>>> = Arc::new(Mutex::new(HashMap::new()));
    let mut completed_nodes = Vec::new();

    for batch in topological_batches(&plan)? {
        let mut handles = Vec::new();

        for node in batch {
            let app = app.clone();
            let pty_manager = pty_manager.clone();
            let review_registry = review_registry.clone();
            let run_id = run_id.to_string();
            let outputs = Arc::clone(&outputs);
            let upstream = Arc::clone(&upstream);
            let providers = providers.clone();

            let _ = app.emit(
                "graph:node-start",
                GraphNodePayload {
                    run_id: run_id.clone(),
                    node_id: node.id.clone(),
                },
            );

            handles.push(thread::spawn(move || {
                let node_id = node.id.clone();
                let result = dispatch_node(
                    &app,
                    &pty_manager,
                    &review_registry,
                    &providers,
                    &run_id,
                    &node,
                    &upstream,
                    &outputs,
                );

                match result {
                    Ok(output) => {
                        if let Ok(mut map) = outputs.lock() {
                            map.insert(node_id.clone(), output);
                        }
                        let _ = app.emit(
                            "graph:node-complete",
                            GraphNodePayload {
                                run_id,
                                node_id: node_id.clone(),
                            },
                        );
                        Ok(node_id)
                    }
                    Err(error) => Err(error),
                }
            }));
        }

        for handle in handles {
            match handle.join() {
                Ok(Ok(node_id)) => completed_nodes.push(node_id),
                Ok(Err(error)) => return Err(error),
                Err(_) => return Err("graph worker thread panicked".to_string()),
            }
        }
    }

    let _ = app.emit(
        "graph:complete",
        GraphCompletePayload {
            run_id: run_id.to_string(),
            completed_nodes,
        },
    );

    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn dispatch_node(
    app: &AppHandle,
    pty_manager: &PtyManager,
    review_registry: &HumanReviewRegistry,
    providers: &HashMap<String, ProviderConfig>,
    run_id: &str,
    node: &NodeConfig,
    upstream: &HashMap<String, Vec<String>>,
    outputs: &Mutex<HashMap<String, String>>,
) -> Result<String, String> {
    match node.node_type.as_str() {
        "collector:result" => run_collector(app, run_id, node, upstream, outputs),
        "orchestrator:pipeline" => run_pipeline_sync(app, run_id, node, upstream, outputs),
        "reviewer:human" => run_human_review(app, review_registry, run_id, node, upstream, outputs),
        _ => run_pty_node(app, pty_manager, providers, run_id, node, upstream, outputs),
    }
}

fn run_pty_node(
    app: &AppHandle,
    pty_manager: &PtyManager,
    providers: &HashMap<String, ProviderConfig>,
    _run_id: &str,
    node: &NodeConfig,
    upstream: &HashMap<String, Vec<String>>,
    outputs: &Mutex<HashMap<String, String>>,
) -> Result<String, String> {
    let provider = providers
        .get(&node.provider)
        .cloned()
        .ok_or_else(|| format!("unknown provider for node {}: {}", node.id, node.provider))?;
    let upstream_outputs = collect_upstream_outputs(&node.id, upstream, outputs);

    let task = PtyTask {
        node_id: Some(node.id.clone()),
        provider: node.provider.clone(),
        prompt: compose_pty_prompt(node, &provider, &upstream_outputs),
        workdir: node.workdir.clone(),
        env: node.env.clone(),
        timeout_ms: node.timeout_ms,
        cols: None,
        rows: None,
        interactive: false,
    };

    let outcome = pty_manager.run_blocking(app, provider, task)?;
    if outcome.success() {
        Ok(outcome.result)
    } else {
        Err(format!(
            "node {} failed: reason={}, exit={:?}, timed_out={}, error_class={:?}, truncated={}",
            outcome.node_id,
            outcome.completion_reason,
            outcome.exit_code,
            outcome.timed_out,
            outcome.error_class,
            outcome.truncated,
        ))
    }
}

fn provider_is_agent(provider: &ProviderConfig) -> bool {
    if provider.display_mode == Some(ProviderDisplayMode::Agent) {
        return true;
    }

    let identity = format!("{} {}", provider.name, provider.command).to_lowercase();
    ["claude", "croxy", "codex", "cursor"]
        .iter()
        .any(|needle| identity.contains(needle))
}

fn should_attach_upstream_to_prompt(node: &NodeConfig, provider: &ProviderConfig) -> bool {
    match node.node_type.as_str() {
        "reviewer:llm" => true,
        "worker:pty" => provider_is_agent(provider),
        _ => false,
    }
}

fn compose_pty_prompt(
    node: &NodeConfig,
    provider: &ProviderConfig,
    upstream_outputs: &[(String, String)],
) -> String {
    if upstream_outputs.is_empty() || !should_attach_upstream_to_prompt(node, provider) {
        return node.prompt.clone();
    }

    let mut prompt = node.prompt.trim_end().to_string();
    if !prompt.is_empty() {
        prompt.push_str("\n\n");
    }
    prompt.push_str(
        "---\n\
Upstream node outputs are included below.\n\
If this task involves code work, the current working directory is the source of truth. \
Inspect `git status` and `git diff` yourself before reviewing or changing code; use the upstream text as context, not as a substitute for the filesystem.\n\n\
Upstream outputs:\n",
    );
    prompt.push_str(&merge_upstream_text(upstream_outputs));
    prompt
}

fn collect_upstream_outputs(
    node_id: &str,
    upstream: &HashMap<String, Vec<String>>,
    outputs: &Mutex<HashMap<String, String>>,
) -> Vec<(String, String)> {
    let parents = upstream.get(node_id).cloned().unwrap_or_default();
    let snapshot = outputs.lock().ok();
    parents
        .into_iter()
        .map(|parent| {
            let value = snapshot
                .as_ref()
                .and_then(|map| map.get(&parent).cloned())
                .unwrap_or_default();
            (parent, value)
        })
        .collect()
}

fn merge_upstream_text(parts: &[(String, String)]) -> String {
    if parts.is_empty() {
        return String::new();
    }
    let mut merged = String::new();
    for (id, value) in parts {
        if !merged.is_empty() {
            merged.push_str("\n\n");
        }
        merged.push_str(&format!("[{id}]\n{value}"));
    }
    merged
}

fn emit_synthetic_outputs(app: &AppHandle, node_id: &str, body: &str) {
    use crate::pty::manager::{PtyAgentPayload, PtyCompletePayload, PtyDataPayload};
    let _ = app.emit(
        "pty:data",
        PtyDataPayload {
            node_id: node_id.to_string(),
            chunk: body.to_string(),
        },
    );
    let _ = app.emit(
        "pty:agent",
        PtyAgentPayload {
            node_id: node_id.to_string(),
            assistant_content: body.to_string(),
            activity: None,
            lines: body.lines().map(str::to_string).collect(),
        },
    );
    let _ = app.emit(
        "pty:complete",
        PtyCompletePayload {
            node_id: node_id.to_string(),
            result: body.to_string(),
            completion_reason: "synthetic".to_string(),
            exit_code: Some(0),
            timed_out: false,
            truncated: false,
            error_class: None,
        },
    );
}

fn run_collector(
    app: &AppHandle,
    _run_id: &str,
    node: &NodeConfig,
    upstream: &HashMap<String, Vec<String>>,
    outputs: &Mutex<HashMap<String, String>>,
) -> Result<String, String> {
    let parts = collect_upstream_outputs(&node.id, upstream, outputs);
    let merged = if parts.is_empty() {
        format!("collector {}: no upstream outputs", node.id)
    } else {
        merge_upstream_text(&parts)
    };
    emit_synthetic_outputs(app, &node.id, &merged);
    Ok(merged)
}

fn run_pipeline_sync(
    app: &AppHandle,
    _run_id: &str,
    node: &NodeConfig,
    upstream: &HashMap<String, Vec<String>>,
    outputs: &Mutex<HashMap<String, String>>,
) -> Result<String, String> {
    let parts = collect_upstream_outputs(&node.id, upstream, outputs);
    let body = if parts.is_empty() {
        format!("pipeline {}: pass-through (no upstream)", node.id)
    } else {
        format!(
            "pipeline {}: synced {} upstream node(s)",
            node.id,
            parts.len()
        )
    };
    emit_synthetic_outputs(app, &node.id, &body);
    Ok(merge_upstream_text(&parts))
}

fn run_human_review(
    app: &AppHandle,
    registry: &HumanReviewRegistry,
    run_id: &str,
    node: &NodeConfig,
    upstream: &HashMap<String, Vec<String>>,
    outputs: &Mutex<HashMap<String, String>>,
) -> Result<String, String> {
    let parts = collect_upstream_outputs(&node.id, upstream, outputs);
    let receiver = registry.register(&node.id)?;
    let upstream_payload = parts
        .iter()
        .map(|(node_id, result)| HumanReviewUpstream {
            node_id: node_id.clone(),
            result: result.clone(),
        })
        .collect::<Vec<_>>();

    let _ = app.emit(
        "graph:human-review-required",
        HumanReviewRequest {
            run_id: run_id.to_string(),
            node_id: node.id.clone(),
            prompt: node.prompt.clone(),
            upstream: upstream_payload,
        },
    );

    let decision = loop {
        match receiver.recv_timeout(Duration::from_millis(500)) {
            Ok(decision) => break decision,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                registry.drop_pending(&node.id);
                return Err(format!(
                    "human-review channel for node {} closed before a decision arrived",
                    node.id
                ));
            }
        }
    };

    match decision {
        HumanReviewDecision::Approve { note } => {
            let body = note.unwrap_or_else(|| format!("human-review {}: approved", node.id));
            emit_synthetic_outputs(app, &node.id, &body);
            Ok(merge_upstream_text(&parts))
        }
        HumanReviewDecision::Reject { reason } => Err(format!(
            "human-review rejected for node {}: {}",
            node.id, reason
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::{compose_pty_prompt, topological_batches};
    use crate::graph::types::{ExecutionMode, ExecutionPlan, GraphEdge, NodeConfig};
    use crate::pty::providers::{
        DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_SETTLE_MS, ProviderConfig, ProviderDisplayMode,
        ProviderInputMode,
    };
    use std::collections::{BTreeMap, HashMap};

    fn node(id: &str) -> NodeConfig {
        NodeConfig {
            id: id.to_string(),
            node_type: "worker:pty".to_string(),
            provider: "shell".to_string(),
            prompt: "echo ok".to_string(),
            workdir: None,
            env: HashMap::new(),
            timeout_ms: None,
        }
    }

    fn provider(name: &str, display_mode: Option<ProviderDisplayMode>) -> ProviderConfig {
        ProviderConfig {
            name: name.to_string(),
            provider_type: "pty".to_string(),
            command: name.to_string(),
            args: Vec::new(),
            env: BTreeMap::new(),
            completion_pattern: String::new(),
            error_pattern: String::new(),
            input_mode: ProviderInputMode::AppendArg,
            display_mode,
            cols: 80,
            rows: 24,
            completion_timeout_ms: 1000,
            idle_timeout_ms: 1000,
            settle_ms: DEFAULT_SETTLE_MS,
            max_output_bytes: DEFAULT_MAX_OUTPUT_BYTES,
        }
    }

    #[test]
    fn builds_parallel_batches_from_dag() {
        let plan = ExecutionPlan {
            nodes: vec![node("a"), node("b"), node("c")],
            edges: vec![
                GraphEdge {
                    from: "a".to_string(),
                    to: "c".to_string(),
                },
                GraphEdge {
                    from: "b".to_string(),
                    to: "c".to_string(),
                },
            ],
            mode: ExecutionMode::Dag,
        };

        let batches = topological_batches(&plan).unwrap();
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0].len(), 2);
        assert_eq!(batches[1][0].id, "c");
    }

    #[test]
    fn rejects_cycles() {
        let plan = ExecutionPlan {
            nodes: vec![node("a"), node("b")],
            edges: vec![
                GraphEdge {
                    from: "a".to_string(),
                    to: "b".to_string(),
                },
                GraphEdge {
                    from: "b".to_string(),
                    to: "a".to_string(),
                },
            ],
            mode: ExecutionMode::Dag,
        };

        assert!(topological_batches(&plan).unwrap_err().contains("cycle"));
    }

    #[test]
    fn reviewer_llm_prompt_includes_upstream_outputs_and_code_review_guidance() {
        let mut reviewer = node("review");
        reviewer.node_type = "reviewer:llm".to_string();
        reviewer.provider = "croxy".to_string();
        reviewer.prompt = "Review the result.".to_string();
        let upstream_outputs = vec![("worker".to_string(), "changed src/main.ts".to_string())];

        let prompt = compose_pty_prompt(
            &reviewer,
            &provider("croxy", Some(ProviderDisplayMode::Agent)),
            &upstream_outputs,
        );

        assert!(prompt.contains("Review the result."));
        assert!(prompt.contains("[worker]\nchanged src/main.ts"));
        assert!(prompt.contains("git status"));
        assert!(prompt.contains("git diff"));
    }

    #[test]
    fn shell_worker_prompt_does_not_attach_upstream_text() {
        let mut shell = node("shell");
        shell.node_type = "worker:shell".to_string();
        shell.provider = "shell".to_string();
        shell.prompt = "pnpm test".to_string();
        let upstream_outputs = vec![("worker".to_string(), "large report".to_string())];

        let prompt = compose_pty_prompt(
            &shell,
            &provider("shell", Some(ProviderDisplayMode::Terminal)),
            &upstream_outputs,
        );

        assert_eq!(prompt, "pnpm test");
    }

    #[test]
    fn agent_worker_prompt_includes_upstream_outputs() {
        let mut worker = node("agent-worker");
        worker.node_type = "worker:pty".to_string();
        worker.provider = "codex".to_string();
        worker.prompt = "Continue the task.".to_string();
        let upstream_outputs = vec![("planner".to_string(), "plan details".to_string())];

        let prompt = compose_pty_prompt(
            &worker,
            &provider("codex", Some(ProviderDisplayMode::Agent)),
            &upstream_outputs,
        );

        assert!(prompt.contains("Continue the task."));
        assert!(prompt.contains("[planner]\nplan details"));
    }
}
