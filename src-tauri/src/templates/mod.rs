use serde::{Deserialize, Serialize};
use std::{env, fs, path::PathBuf};

#[derive(Debug, Clone, Serialize)]
pub struct TemplateMetadata {
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub builtin: bool,
    pub node_count: usize,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplatePayload {
    pub display_name: String,
    pub description: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct TemplatesResponse {
    pub templates: Vec<TemplateMetadata>,
    pub directory: String,
}

pub fn templates_dir() -> PathBuf {
    env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".loom")
        .join("templates")
}

pub fn list_templates() -> Result<TemplatesResponse, String> {
    let mut templates = builtin_templates()
        .into_iter()
        .map(|(name, meta)| TemplateMetadata {
            name: name.to_string(),
            display_name: meta.display_name,
            description: meta.description,
            builtin: true,
            node_count: count_nodes(&meta.payload),
            path: None,
        })
        .collect::<Vec<_>>();

    let dir = templates_dir();
    if dir.exists() {
        for entry in fs::read_dir(&dir)
            .map_err(|error| format!("failed to read {}: {error}", dir.display()))?
        {
            let entry = entry.map_err(|error| format!("template entry read failed: {error}"))?;
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let raw = fs::read_to_string(&path)
                .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
            let payload: TemplatePayload = serde_json::from_str(&raw).map_err(|error| {
                format!("failed to parse template {}: {error}", path.display())
            })?;
            let name = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or_default()
                .to_string();
            templates.push(TemplateMetadata {
                name,
                display_name: payload.display_name,
                description: payload.description,
                builtin: false,
                node_count: count_nodes(&payload.payload),
                path: Some(path.display().to_string()),
            });
        }
    }

    Ok(TemplatesResponse {
        templates,
        directory: dir.display().to_string(),
    })
}

pub fn load_template(name: &str) -> Result<String, String> {
    if let Some(builtin) = builtin_templates()
        .into_iter()
        .find(|(slug, _)| *slug == name)
    {
        return Ok(serde_json::to_string(&builtin.1.payload)
            .map_err(|error| format!("failed to serialize builtin template: {error}"))?);
    }

    let path = template_path(name)?;
    if !path.exists() {
        return Err(format!("template not found: {name}"));
    }
    let raw = fs::read_to_string(&path)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    let parsed: TemplatePayload = serde_json::from_str(&raw)
        .map_err(|error| format!("failed to parse template {name}: {error}"))?;
    serde_json::to_string(&parsed.payload)
        .map_err(|error| format!("failed to serialize template payload: {error}"))
}

pub fn save_template(name: &str, payload: TemplatePayload) -> Result<PathBuf, String> {
    let path = template_path(name)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    }
    let serialized = serde_json::to_string_pretty(&payload)
        .map_err(|error| format!("failed to serialize template: {error}"))?;
    fs::write(&path, serialized)
        .map_err(|error| format!("failed to write {}: {error}", path.display()))?;
    Ok(path)
}

pub fn delete_template(name: &str) -> Result<(), String> {
    let path = template_path(name)?;
    if !path.exists() {
        return Ok(());
    }
    fs::remove_file(&path)
        .map_err(|error| format!("failed to remove {}: {error}", path.display()))?;
    Ok(())
}

fn template_path(name: &str) -> Result<PathBuf, String> {
    if name.is_empty() {
        return Err("template name must not be empty".to_string());
    }
    if name
        .chars()
        .any(|c| !(c.is_alphanumeric() || c == '-' || c == '_'))
    {
        return Err(format!(
            "template name must be alphanumeric, '-', or '_': {name}"
        ));
    }
    Ok(templates_dir().join(format!("{name}.json")))
}

fn count_nodes(payload: &serde_json::Value) -> usize {
    payload
        .get("nodes")
        .and_then(|nodes| nodes.as_array())
        .map(|nodes| nodes.len())
        .unwrap_or(0)
}

struct BuiltinTemplate {
    display_name: String,
    description: String,
    payload: serde_json::Value,
}

fn builtin_templates() -> Vec<(&'static str, BuiltinTemplate)> {
    vec![
        (
            "review-pipeline",
            BuiltinTemplate {
                display_name: "Review Pipeline".to_string(),
                description: "Implement → LLM Review → Shell test".to_string(),
                payload: serde_json::from_str(REVIEW_PIPELINE_JSON)
                    .expect("review-pipeline builtin is valid JSON"),
            },
        ),
        (
            "fan-out-merge",
            BuiltinTemplate {
                display_name: "Fan-out + Merge".to_string(),
                description: "Two workers in parallel, results collected".to_string(),
                payload: serde_json::from_str(FAN_OUT_JSON)
                    .expect("fan-out-merge builtin is valid JSON"),
            },
        ),
        (
            "human-gate",
            BuiltinTemplate {
                display_name: "Worker → Human Gate".to_string(),
                description: "Worker output blocks on human approval".to_string(),
                payload: serde_json::from_str(HUMAN_GATE_JSON)
                    .expect("human-gate builtin is valid JSON"),
            },
        ),
    ]
}

const REVIEW_PIPELINE_JSON: &str = r#"{
  "version": 1,
  "nodes": [
    {
      "id": "tpl-impl",
      "type": "worker:pty",
      "meta": { "name": "Implementer", "category": "worker", "colorToken": "node/worker" },
      "provider": "codex",
      "prompt": "요청한 변경을 구현하세요.",
      "position": { "x": 80, "y": 80 }
    },
    {
      "id": "tpl-review",
      "type": "reviewer:llm",
      "meta": { "name": "LLM Reviewer", "category": "reviewer", "colorToken": "node/reviewer" },
      "provider": "claude-code",
      "prompt": "방금 변경된 부분을 리뷰하고, 보안·테스트 누락을 지적하세요.",
      "position": { "x": 480, "y": 80 }
    },
    {
      "id": "tpl-test",
      "type": "worker:shell",
      "meta": { "name": "Tester", "category": "worker", "colorToken": "node/worker" },
      "provider": "shell",
      "prompt": "pnpm test --silent 2>&1 | tail -200",
      "position": { "x": 880, "y": 80 }
    }
  ],
  "edges": [
    { "id": "tpl-impl->tpl-review", "source": "tpl-impl", "target": "tpl-review" },
    { "id": "tpl-review->tpl-test", "source": "tpl-review", "target": "tpl-test" }
  ]
}"#;

const FAN_OUT_JSON: &str = r#"{
  "version": 1,
  "nodes": [
    {
      "id": "tpl-a",
      "type": "worker:pty",
      "meta": { "name": "Worker A", "category": "worker", "colorToken": "node/worker" },
      "provider": "codex",
      "prompt": "A 경로를 구현하세요.",
      "position": { "x": 80, "y": 60 }
    },
    {
      "id": "tpl-b",
      "type": "worker:pty",
      "meta": { "name": "Worker B", "category": "worker", "colorToken": "node/worker" },
      "provider": "claude-code",
      "prompt": "B 경로를 구현하세요.",
      "position": { "x": 80, "y": 320 }
    },
    {
      "id": "tpl-collect",
      "type": "collector:result",
      "meta": { "name": "Collector", "category": "collector", "colorToken": "node/collector" },
      "provider": "shell",
      "prompt": "두 결과를 병합합니다.",
      "position": { "x": 480, "y": 180 }
    }
  ],
  "edges": [
    { "id": "tpl-a->tpl-collect", "source": "tpl-a", "target": "tpl-collect" },
    { "id": "tpl-b->tpl-collect", "source": "tpl-b", "target": "tpl-collect" }
  ]
}"#;

const HUMAN_GATE_JSON: &str = r#"{
  "version": 1,
  "nodes": [
    {
      "id": "tpl-worker",
      "type": "worker:pty",
      "meta": { "name": "Worker", "category": "worker", "colorToken": "node/worker" },
      "provider": "claude-code",
      "prompt": "변경 사항을 준비하세요.",
      "position": { "x": 80, "y": 80 }
    },
    {
      "id": "tpl-gate",
      "type": "reviewer:human",
      "meta": { "name": "Human Gate", "category": "reviewer", "colorToken": "node/reviewer" },
      "provider": "shell",
      "prompt": "사람이 직접 검토 후 승인합니다.",
      "position": { "x": 480, "y": 80 }
    },
    {
      "id": "tpl-apply",
      "type": "worker:shell",
      "meta": { "name": "Apply", "category": "worker", "colorToken": "node/worker" },
      "provider": "shell",
      "prompt": "echo applying changes",
      "position": { "x": 880, "y": 80 }
    }
  ],
  "edges": [
    { "id": "tpl-worker->tpl-gate", "source": "tpl-worker", "target": "tpl-gate" },
    { "id": "tpl-gate->tpl-apply", "source": "tpl-gate", "target": "tpl-apply" }
  ]
}"#;

#[cfg(test)]
mod tests {
    use super::{builtin_templates, count_nodes, template_path, templates_dir};

    #[test]
    fn templates_dir_under_loom() {
        assert!(templates_dir().ends_with(".loom/templates"));
    }

    #[test]
    fn template_path_rejects_unsafe_names() {
        assert!(template_path("../etc/passwd").is_err());
        assert!(template_path("ok-name_1").is_ok());
    }

    #[test]
    fn builtin_templates_have_nodes() {
        for (name, meta) in builtin_templates() {
            let count = count_nodes(&meta.payload);
            assert!(count > 0, "{name} should have nodes");
        }
    }
}
