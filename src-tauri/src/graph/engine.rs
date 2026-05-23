use super::types::{ExecutionMode, ExecutionPlan, NodeConfig};
use crate::pty::{
    manager::{PtyManager, PtyTask},
    providers::load_provider_configs,
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
        map.entry(edge.to.clone()).or_default().push(edge.from.clone());
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
    providers: &HashMap<String, crate::pty::providers::ProviderConfig>,
    run_id: &str,
    node: &NodeConfig,
    upstream: &HashMap<String, Vec<String>>,
    outputs: &Mutex<HashMap<String, String>>,
) -> Result<String, String> {
    match node.node_type.as_str() {
        "collector:result" => run_collector(app, run_id, node, upstream, outputs),
        "orchestrator:pipeline" => run_pipeline_sync(app, run_id, node, upstream, outputs),
        "reviewer:human" => {
            run_human_review(app, review_registry, run_id, node, upstream, outputs)
        }
        _ => run_pty_node(app, pty_manager, providers, run_id, node),
    }
}

fn run_pty_node(
    app: &AppHandle,
    pty_manager: &PtyManager,
    providers: &HashMap<String, crate::pty::providers::ProviderConfig>,
    _run_id: &str,
    node: &NodeConfig,
) -> Result<String, String> {
    let provider = providers
        .get(&node.provider)
        .cloned()
        .ok_or_else(|| format!("unknown provider for node {}: {}", node.id, node.provider))?;

    let task = PtyTask {
        node_id: Some(node.id.clone()),
        provider: node.provider.clone(),
        prompt: node.prompt.clone(),
        workdir: node.workdir.clone(),
        env: node.env.clone(),
        timeout_ms: node.timeout_ms,
        cols: None,
        rows: None,
    };

    let outcome = pty_manager.run_blocking(app, provider, task)?;
    if outcome.success() {
        Ok(outcome.result)
    } else {
        Err(format!(
            "node {} failed: reason={}, exit={:?}, timed_out={}",
            outcome.node_id, outcome.completion_reason, outcome.exit_code, outcome.timed_out
        ))
    }
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
    use crate::pty::manager::{PtyCompletePayload, PtyDataPayload};
    let _ = app.emit(
        "pty:data",
        PtyDataPayload {
            node_id: node_id.to_string(),
            chunk: body.to_string(),
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
    use super::topological_batches;
    use crate::graph::types::{ExecutionMode, ExecutionPlan, GraphEdge, NodeConfig};
    use std::collections::HashMap;

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
}
