use std::{
    env, fs,
    path::{Path, PathBuf},
};

pub fn workspace_path() -> PathBuf {
    workspace_path_from(
        &env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(".")),
    )
}

pub fn save_workspace(payload: &str) -> Result<PathBuf, String> {
    let path = workspace_path();
    save_workspace_at(&path, payload)?;
    Ok(path)
}

pub fn load_workspace() -> Result<Option<String>, String> {
    load_workspace_at(&workspace_path())
}

pub fn normalize_project_root(root: impl AsRef<Path>) -> Result<PathBuf, String> {
    let root = root.as_ref();
    if !root.exists() {
        return Err(format!("project root does not exist: {}", root.display()));
    }
    if !root.is_dir() {
        return Err(format!(
            "project root is not a directory: {}",
            root.display()
        ));
    }
    fs::canonicalize(root)
        .map_err(|error| format!("failed to canonicalize {}: {error}", root.display()))
}

pub fn project_graph_path(root: impl AsRef<Path>) -> PathBuf {
    root.as_ref().join(".loom").join("graph.json")
}

pub fn workspace_graph_path(workspace_id: &str) -> PathBuf {
    let registry_path = workspace_path();
    registry_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("workspaces")
        .join(workspace_id)
        .join("graph.json")
}

pub fn save_workspace_graph(workspace_id: &str, payload: &str) -> Result<PathBuf, String> {
    let path = workspace_graph_path(workspace_id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    }
    fs::write(&path, payload)
        .map_err(|error| format!("failed to write {}: {error}", path.display()))?;
    Ok(path)
}

pub fn load_workspace_graph(
    workspace_id: &str,
    fallback_root: Option<impl AsRef<Path>>,
) -> Result<(PathBuf, Option<String>), String> {
    let path = workspace_graph_path(workspace_id);
    if path.exists() {
        let payload = fs::read_to_string(&path)
            .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
        return Ok((path, Some(payload)));
    }

    if let Some(root) = fallback_root {
        let fallback_path = project_graph_path(root.as_ref());
        if fallback_path.exists() {
            let payload = fs::read_to_string(&fallback_path)
                .map_err(|error| format!("failed to read {}: {error}", fallback_path.display()))?;
            return Ok((path, Some(payload)));
        }
    }

    Ok((path, None))
}

pub fn save_project_graph(root: impl AsRef<Path>, payload: &str) -> Result<PathBuf, String> {
    let root = normalize_project_root(root)?;
    let path = project_graph_path(&root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    }
    fs::write(&path, payload)
        .map_err(|error| format!("failed to write {}: {error}", path.display()))?;
    Ok(path)
}

pub fn load_project_graph(root: impl AsRef<Path>) -> Result<Option<String>, String> {
    let root = normalize_project_root(root)?;
    let path = project_graph_path(&root);
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(&path)
        .map(Some)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))
}

fn workspace_path_from(home: &Path) -> PathBuf {
    home.join(".loom").join("workspace.json")
}

fn workspace_backup_v1_path(workspace_path: &Path) -> PathBuf {
    workspace_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("workspace.v1.bak.json")
}

fn save_workspace_at(path: &Path, payload: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    }
    maybe_backup_v1_workspace(path, payload)?;
    fs::write(path, payload)
        .map_err(|error| format!("failed to write {}: {error}", path.display()))?;
    Ok(())
}

fn load_workspace_at(path: &Path) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(&path)
        .map(Some)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))
}

fn maybe_backup_v1_workspace(path: &Path, next_payload: &str) -> Result<(), String> {
    if !matches!(detect_workspace_version(next_payload), Some(2 | 3)) || !path.exists() {
        return Ok(());
    }

    let current_payload = fs::read_to_string(path)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    if detect_workspace_version(&current_payload) != Some(1) {
        return Ok(());
    }

    let backup_path = workspace_backup_v1_path(path);
    if backup_path.exists() {
        return Ok(());
    }

    fs::write(&backup_path, current_payload)
        .map_err(|error| format!("failed to write {}: {error}", backup_path.display()))
}

fn detect_workspace_version(payload: &str) -> Option<u64> {
    serde_json::from_str::<serde_json::Value>(payload)
        .ok()?
        .get("version")?
        .as_u64()
}

#[cfg(test)]
mod tests {
    use super::{
        load_project_graph, load_workspace_at, normalize_project_root, project_graph_path,
        save_project_graph, save_workspace_at, workspace_backup_v1_path, workspace_path,
        workspace_path_from,
    };
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
    fn save_workspace_backs_up_v1_before_v2_overwrite() {
        let home = temp_project_root("workspace-home");
        let workspace = workspace_path_from(&home);
        let original = r#"{"version":1,"nodes":[{"id":"legacy"}],"edges":[]}"#;
        let updated = r#"{"version":2,"projects":[],"openTabs":[],"activeTabId":null}"#;

        save_workspace_at(&workspace, original).expect("save v1 workspace");
        save_workspace_at(&workspace, updated).expect("save v2 workspace");

        let backup = workspace_backup_v1_path(&workspace);
        assert_eq!(fs::read_to_string(&backup).expect("read backup"), original);
        assert_eq!(
            load_workspace_at(&workspace)
                .expect("load workspace")
                .expect("workspace payload"),
            updated
        );

        fs::remove_dir_all(home).expect("remove temp home");
    }

    #[test]
    fn save_workspace_skips_backup_for_non_v2_payloads() {
        let home = temp_project_root("workspace-non-v2-home");
        let workspace = workspace_path_from(&home);
        let payload = r#"{"version":1,"nodes":[],"edges":[]}"#;

        save_workspace_at(&workspace, payload).expect("save workspace");

        assert!(!workspace_backup_v1_path(&workspace).exists());

        fs::remove_dir_all(home).expect("remove temp home");
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
        let canonical_root = fs::canonicalize(&root).expect("canonicalize root");

        assert_eq!(path, canonical_root.join(".loom").join("graph.json"));
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

    #[test]
    fn normalize_project_root_canonicalizes_existing_directory() {
        let root = temp_project_root("normalize-root");
        let child = root.join("nested");
        fs::create_dir_all(&child).expect("create nested dir");

        let normalized = normalize_project_root(child.join("..")).expect("normalize root");

        assert_eq!(
            normalized,
            fs::canonicalize(&root).expect("canonicalize root")
        );

        fs::remove_dir_all(root).expect("remove temp project root");
    }

    #[test]
    fn normalize_project_root_rejects_missing_directory() {
        let missing = temp_path("normalize-missing");

        let error = normalize_project_root(&missing).expect_err("normalize should fail");

        assert!(error.contains("project root does not exist"));
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
