use std::{env, fs, path::PathBuf};

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

#[cfg(test)]
mod tests {
    use super::workspace_path;

    #[test]
    fn workspace_path_under_loom_dir() {
        assert!(workspace_path().ends_with(".loom/workspace.json"));
    }
}
