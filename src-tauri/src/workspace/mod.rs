use std::{
    env, fs,
    path::{Path, PathBuf},
};

pub fn workspace_path() -> PathBuf {
    env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".loom")
        .join("workspace.json")
}

pub fn save_workspace(payload: &str) -> Result<PathBuf, String> {
    let path = workspace_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    }
    fs::write(&path, payload)
        .map_err(|error| format!("failed to write {}: {error}", path.display()))?;
    Ok(path)
}

pub fn load_workspace() -> Result<Option<String>, String> {
    let path = workspace_path();
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(&path)
        .map(Some)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))
}

pub fn project_graph_path(root: impl AsRef<Path>) -> PathBuf {
    root.as_ref().join(".loom").join("graph.json")
}

pub fn save_project_graph(root: impl AsRef<Path>, payload: &str) -> Result<PathBuf, String> {
    let root = validate_project_root(root.as_ref())?;
    let path = project_graph_path(root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    }
    fs::write(&path, payload)
        .map_err(|error| format!("failed to write {}: {error}", path.display()))?;
    Ok(path)
}

pub fn load_project_graph(root: impl AsRef<Path>) -> Result<Option<String>, String> {
    let root = validate_project_root(root.as_ref())?;
    let path = project_graph_path(root);
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(&path)
        .map(Some)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))
}

fn validate_project_root(root: &Path) -> Result<&Path, String> {
    if !root.exists() {
        return Err(format!("project root does not exist: {}", root.display()));
    }
    if !root.is_dir() {
        return Err(format!(
            "project root is not a directory: {}",
            root.display()
        ));
    }
    Ok(root)
}

#[cfg(test)]
mod tests {
    use super::{load_project_graph, project_graph_path, save_project_graph, workspace_path};
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn workspace_path_under_loom_dir() {
        assert!(workspace_path().ends_with(".loom/workspace.json"));
    }

    #[test]
    fn project_graph_path_under_project_loom_dir() {
        let root = temp_path("graph-path-root");

        assert!(project_graph_path(&root).ends_with(".loom/graph.json"));
    }

    #[test]
    fn save_project_graph_creates_graph_and_preserves_payload() {
        let root = temp_project_root("save-graph");
        let payload = r#"{"nodes":[{"id":"agent-1"}],"edges":[]}"#;

        let path = save_project_graph(&root, payload).expect("save graph");

        assert_eq!(path, root.join(".loom").join("graph.json"));
        assert_eq!(fs::read_to_string(path).expect("read graph"), payload);

        fs::remove_dir_all(root).expect("remove temp project root");
    }

    #[test]
    fn load_project_graph_returns_none_when_missing() {
        let root = temp_project_root("missing-graph");

        let payload = load_project_graph(&root).expect("load graph");

        assert!(payload.is_none());

        fs::remove_dir_all(root).expect("remove temp project root");
    }

    #[test]
    fn save_project_graph_fails_when_root_does_not_exist() {
        let root = temp_path("missing-root");

        let error = save_project_graph(&root, "{}").expect_err("save should fail");

        assert!(error.contains("project root does not exist"));
    }

    #[test]
    fn save_project_graph_fails_when_root_is_not_directory() {
        let root = temp_path("file-root");
        fs::write(&root, "not a directory").expect("write temp file");

        let error = save_project_graph(&root, "{}").expect_err("save should fail");

        assert!(error.contains("project root is not a directory"));

        fs::remove_file(root).expect("remove temp file");
    }

    fn temp_project_root(label: &str) -> PathBuf {
        let root = temp_path(label);
        fs::create_dir_all(&root).expect("create temp project root");
        root
    }

    fn temp_path(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("loom-workspace-test-{label}-{nanos}"))
    }
}
