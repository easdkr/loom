use std::{
    collections::HashMap,
    sync::{mpsc, Arc, Mutex},
};

#[derive(Debug, Clone)]
pub enum HumanReviewDecision {
    Approve { note: Option<String> },
    Reject { reason: String },
}

#[derive(Clone, Default)]
pub struct HumanReviewRegistry {
    pending: Arc<Mutex<HashMap<String, mpsc::Sender<HumanReviewDecision>>>>,
}

impl HumanReviewRegistry {
    pub fn register(&self, node_id: &str) -> Result<mpsc::Receiver<HumanReviewDecision>, String> {
        let (tx, rx) = mpsc::channel();
        let mut map = self
            .pending
            .lock()
            .map_err(|_| "failed to lock human review registry".to_string())?;
        if map.contains_key(node_id) {
            return Err(format!("human-review already pending for node {node_id}"));
        }
        map.insert(node_id.to_string(), tx);
        Ok(rx)
    }

    pub fn resolve(&self, node_id: &str, decision: HumanReviewDecision) -> Result<(), String> {
        let mut map = self
            .pending
            .lock()
            .map_err(|_| "failed to lock human review registry".to_string())?;
        let sender = map
            .remove(node_id)
            .ok_or_else(|| format!("no pending human review for node {node_id}"))?;
        sender
            .send(decision)
            .map_err(|_| format!("failed to deliver decision to node {node_id}"))
    }

    pub fn drop_pending(&self, node_id: &str) {
        if let Ok(mut map) = self.pending.lock() {
            map.remove(node_id);
        }
    }
}
