use super::types::{ExecutionMode, ExecutionPlan, NodeConfig};
use crate::pty::{
    manager::{PtyManager, PtyTask},
    providers::load_provider_configs,
};
use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
    thread,
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

pub fn execute_plan_background(
    app: AppHandle,
    pty_manager: PtyManager,
    run_id: String,
    plan: ExecutionPlan,
) {
    thread::spawn(move || {
        if let Err(error) = execute_plan(&app, pty_manager, &run_id, plan) {
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

fn execute_plan(
    app: &AppHandle,
    pty_manager: PtyManager,
    run_id: &str,
    plan: ExecutionPlan,
) -> Result<(), String> {
    let providers = load_provider_configs()?
        .into_iter()
        .map(|provider| (provider.name.clone(), provider))
        .collect::<HashMap<_, _>>();
    let mut completed_nodes = Vec::new();

    for batch in topological_batches(&plan)? {
        let mut handles = Vec::new();

        for node in batch {
            let provider = providers.get(&node.provider).cloned().ok_or_else(|| {
                format!("unknown provider for node {}: {}", node.id, node.provider)
            })?;
            let app = app.clone();
            let pty_manager = pty_manager.clone();
            let run_id = run_id.to_string();

            let _ = app.emit(
                "graph:node-start",
                GraphNodePayload {
                    run_id: run_id.clone(),
                    node_id: node.id.clone(),
                },
            );

            handles.push(thread::spawn(move || {
                let node_id = node.id.clone();
                let task = PtyTask {
                    node_id: Some(node.id),
                    provider: node.provider,
                    prompt: node.prompt,
                    workdir: node.workdir,
                    env: node.env,
                    timeout_ms: node.timeout_ms,
                    cols: None,
                    rows: None,
                };

                match pty_manager.run_blocking(&app, provider, task) {
                    Ok(outcome) if outcome.success() => {
                        let _ = app.emit(
                            "graph:node-complete",
                            GraphNodePayload {
                                run_id,
                                node_id: node_id.clone(),
                            },
                        );
                        Ok(node_id)
                    }
                    Ok(outcome) => Err(format!(
                        "node {} failed: reason={}, exit={:?}, timed_out={}",
                        outcome.node_id,
                        outcome.completion_reason,
                        outcome.exit_code,
                        outcome.timed_out
                    )),
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
