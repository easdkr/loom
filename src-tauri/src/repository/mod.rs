use crate::{git, workspace};
use serde::{Deserialize, Serialize};
use std::{
    env,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum RepositoryKind {
    Local,
    Cloned,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    pub id: String,
    pub name: String,
    pub source_root: String,
    pub remote_url: Option<String>,
    pub default_branch: String,
    pub kind: RepositoryKind,
    pub created_at: u64,
    pub last_opened_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum WorkspaceRepoBindingKind {
    ExistingRoot,
    Worktree,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRepoBinding {
    pub repo_id: String,
    pub branch: String,
    pub worktree_path: String,
    pub binding_kind: WorkspaceRepoBindingKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub repo_bindings: Vec<WorkspaceRepoBinding>,
    pub active_repo_id: String,
    pub created_at: u64,
    pub last_opened_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRegistryV3 {
    pub version: u8,
    pub repositories: Vec<Repository>,
    pub workspaces: Vec<Workspace>,
    pub open_tabs: Vec<String>,
    pub active_workspace_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMutationResponse {
    pub registry: WorkspaceRegistryV3,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceStatusResponse {
    pub workspace_id: String,
    pub repositories: Vec<WorkspaceRepoStatus>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceRepoStatus {
    pub repo_id: String,
    pub worktree_path: String,
    pub dirty: bool,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct NodeWorktreePrepareResponse {
    pub worktree_path: String,
    pub branch: String,
}

pub fn register_local(root: impl AsRef<Path>) -> Result<Repository, String> {
    let repo_root = git::repo_root(root)?;
    let now = now_millis();
    Ok(Repository {
        id: create_id("repo"),
        name: file_name(&repo_root),
        source_root: repo_root.display().to_string(),
        remote_url: git::remote_url(&repo_root),
        default_branch: git::default_branch(&repo_root),
        kind: RepositoryKind::Local,
        created_at: now,
        last_opened_at: now,
    })
}

pub fn clone_repository(url: &str, name: Option<&str>) -> Result<Repository, String> {
    let repo_name = name
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| name_from_git_url(url));
    let id = create_id("repo");
    let target = loom_home()
        .join("repos")
        .join(format!("{}-{}", slugify(&repo_name), short_id(&id)))
        .join("source");
    git::clone_repo(url, &target)?;
    let mut repository = register_local(&target)?;
    repository.id = id;
    repository.name = repo_name;
    repository.remote_url = Some(url.to_string());
    repository.kind = RepositoryKind::Cloned;
    Ok(repository)
}

pub fn create_workspace(
    name: &str,
    repo_ids: &[String],
    base_ref: Option<&str>,
    request_repositories: &[Repository],
) -> Result<WorkspaceMutationResponse, String> {
    if repo_ids.is_empty() {
        return Err("workspace requires at least one repository".to_string());
    }

    let mut registry = load_v3_registry()?.unwrap_or_else(empty_registry);
    merge_repositories(&mut registry.repositories, request_repositories);

    let id = create_id("workspace");
    let now = now_millis();
    let workspace_slug = slugify(name);
    let mut bindings = Vec::new();

    for repo_id in repo_ids {
        let repository = registry
            .repositories
            .iter()
            .find(|item| &item.id == repo_id)
            .ok_or_else(|| format!("repository not found: {repo_id}"))?;
        let repo_slug = slugify(&repository.name);
        let short = short_id(&id);
        let branch = format!("loom/{workspace_slug}/{repo_slug}-{short}");
        let worktree_path = loom_home()
            .join("worktrees")
            .join(&repository.id)
            .join(format!("{workspace_slug}-{short}"));
        let base = resolve_base_ref(
            &repository.source_root,
            base_ref,
            &repository.default_branch,
        );
        git::worktree_add(&repository.source_root, &worktree_path, &branch, &base)?;
        bindings.push(WorkspaceRepoBinding {
            repo_id: repository.id.clone(),
            branch,
            worktree_path: worktree_path.display().to_string(),
            binding_kind: WorkspaceRepoBindingKind::Worktree,
        });
    }

    let workspace = Workspace {
        id: id.clone(),
        name: name.trim().to_string(),
        active_repo_id: repo_ids[0].clone(),
        repo_bindings: bindings,
        created_at: now,
        last_opened_at: now,
    };
    registry.workspaces.push(workspace);
    if !registry.open_tabs.contains(&id) {
        registry.open_tabs.push(id.clone());
    }
    registry.active_workspace_id = Some(id);
    save_v3_registry(&registry)?;
    Ok(WorkspaceMutationResponse { registry })
}

pub fn remove_workspace(
    workspace_id: &str,
    force: bool,
) -> Result<WorkspaceMutationResponse, String> {
    let mut registry = load_v3_registry()?.unwrap_or_else(empty_registry);
    let workspace = registry
        .workspaces
        .iter()
        .find(|item| item.id == workspace_id)
        .cloned()
        .ok_or_else(|| format!("workspace not found: {workspace_id}"))?;

    for binding in &workspace.repo_bindings {
        if binding.binding_kind != WorkspaceRepoBindingKind::Worktree {
            continue;
        }
        if !force {
            let status = git::status_porcelain(&binding.worktree_path)?;
            if !status.is_empty() {
                return Err(format!(
                    "worktree has uncommitted changes: {}",
                    binding.worktree_path
                ));
            }
        }
        let repository = registry
            .repositories
            .iter()
            .find(|item| item.id == binding.repo_id)
            .ok_or_else(|| format!("repository not found: {}", binding.repo_id))?;
        if !force && !git::branch_is_merged_into_head(&repository.source_root, &binding.branch) {
            return Err(format!(
                "branch is not merged and cannot be safely deleted: {}",
                binding.branch
            ));
        }
    }

    for binding in &workspace.repo_bindings {
        if binding.binding_kind == WorkspaceRepoBindingKind::Worktree {
            let repository = registry
                .repositories
                .iter()
                .find(|item| item.id == binding.repo_id)
                .ok_or_else(|| format!("repository not found: {}", binding.repo_id))?;
            git::worktree_remove(&binding.worktree_path, force)?;
            git::delete_local_branch(&repository.source_root, &binding.branch, force)?;
        }
    }

    registry
        .workspaces
        .retain(|workspace| workspace.id != workspace_id);
    registry.open_tabs.retain(|id| id != workspace_id);
    if registry.active_workspace_id.as_deref() == Some(workspace_id) {
        registry.active_workspace_id = registry.open_tabs.first().cloned();
    }
    save_v3_registry(&registry)?;
    Ok(WorkspaceMutationResponse { registry })
}

pub fn workspace_status(workspace_id: &str) -> Result<WorkspaceStatusResponse, String> {
    let registry = load_v3_registry()?.unwrap_or_else(empty_registry);
    let workspace = registry
        .workspaces
        .iter()
        .find(|item| item.id == workspace_id)
        .ok_or_else(|| format!("workspace not found: {workspace_id}"))?;
    let repositories = workspace
        .repo_bindings
        .iter()
        .map(|binding| {
            let status = git::status_porcelain(&binding.worktree_path)?;
            Ok(WorkspaceRepoStatus {
                repo_id: binding.repo_id.clone(),
                worktree_path: binding.worktree_path.clone(),
                dirty: !status.is_empty(),
                status,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(WorkspaceStatusResponse {
        workspace_id: workspace_id.to_string(),
        repositories,
    })
}

pub fn prepare_node_worktree(
    workspace_id: &str,
    repo_id: &str,
    node_id: &str,
) -> Result<NodeWorktreePrepareResponse, String> {
    let registry = load_v3_registry()?.unwrap_or_else(empty_registry);
    let workspace = registry
        .workspaces
        .iter()
        .find(|item| item.id == workspace_id)
        .ok_or_else(|| format!("workspace not found: {workspace_id}"))?;
    let binding = workspace
        .repo_bindings
        .iter()
        .find(|item| item.repo_id == repo_id)
        .ok_or_else(|| format!("repository binding not found: {repo_id}"))?;
    let node_slug = slugify(node_id);
    let repo_slug = registry
        .repositories
        .iter()
        .find(|item| item.id == repo_id)
        .map(|item| slugify(&item.name))
        .unwrap_or_else(|| slugify(repo_id));
    let unique = short_id(&create_id("node"));
    let branch = format!(
        "loom/{}/{}/{}-{}",
        slugify(&workspace.name),
        node_slug,
        repo_slug,
        unique
    );
    let worktree_path = loom_home()
        .join("worktrees")
        .join(repo_id)
        .join("nodes")
        .join(format!("{}-{}", node_slug, unique));
    git::worktree_add(&binding.worktree_path, &worktree_path, &branch, "HEAD")?;
    Ok(NodeWorktreePrepareResponse {
        worktree_path: worktree_path.display().to_string(),
        branch,
    })
}

fn load_v3_registry() -> Result<Option<WorkspaceRegistryV3>, String> {
    let payload = match workspace::load_workspace()? {
        Some(payload) => payload,
        None => return Ok(None),
    };
    let version = serde_json::from_str::<serde_json::Value>(&payload)
        .map_err(|error| format!("failed to parse workspace registry: {error}"))?
        .get("version")
        .and_then(|value| value.as_u64())
        .unwrap_or_default();
    if version != 3 {
        return Err("workspace registry must be migrated to version 3".to_string());
    }
    serde_json::from_str(&payload)
        .map(Some)
        .map_err(|error| format!("failed to parse v3 workspace registry: {error}"))
}

fn save_v3_registry(registry: &WorkspaceRegistryV3) -> Result<(), String> {
    let payload = serde_json::to_string(registry)
        .map_err(|error| format!("failed to serialize workspace registry: {error}"))?;
    workspace::save_workspace(&payload)?;
    Ok(())
}

fn empty_registry() -> WorkspaceRegistryV3 {
    WorkspaceRegistryV3 {
        version: 3,
        repositories: Vec::new(),
        workspaces: Vec::new(),
        open_tabs: Vec::new(),
        active_workspace_id: None,
    }
}

fn merge_repositories(target: &mut Vec<Repository>, incoming: &[Repository]) {
    for repository in incoming {
        if let Some(existing) = target
            .iter_mut()
            .find(|item| item.id == repository.id || item.source_root == repository.source_root)
        {
            let id = existing.id.clone();
            *existing = repository.clone();
            existing.id = id;
        } else {
            target.push(repository.clone());
        }
    }
}

fn resolve_base_ref(source_root: &str, base_ref: Option<&str>, default_branch: &str) -> String {
    let preferred = base_ref
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(default_branch);
    if git::ref_exists(source_root, preferred) {
        return preferred.to_string();
    }
    let origin_ref = format!("origin/{preferred}");
    if git::ref_exists(source_root, &origin_ref) {
        return origin_ref;
    }
    "HEAD".to_string()
}

fn loom_home() -> PathBuf {
    env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".loom")
}

fn create_id(prefix: &str) -> String {
    format!("{prefix}_{}", now_nanos())
}

fn short_id(value: &str) -> String {
    value
        .chars()
        .rev()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .take(8)
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| path.display().to_string())
}

fn name_from_git_url(url: &str) -> String {
    let without_slash = url.trim_end_matches('/');
    let name = without_slash
        .rsplit(['/', ':'])
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or("repository")
        .trim_end_matches(".git");
    name.to_string()
}

fn slugify(value: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = false;
    for ch in value.chars().flat_map(char::to_lowercase) {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            last_dash = false;
        } else if !last_dash && !slug.is_empty() {
            slug.push('-');
            last_dash = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        "workspace".to_string()
    } else {
        slug.chars().take(48).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::{name_from_git_url, slugify};

    #[test]
    fn git_url_name_strips_suffixes() {
        assert_eq!(name_from_git_url("git@github.com:wise/loom.git"), "loom");
        assert_eq!(
            name_from_git_url("https://github.com/wise/admin-web"),
            "admin-web"
        );
    }

    #[test]
    fn slugify_keeps_paths_shell_safe() {
        assert_eq!(slugify("Munich V5 / Loom"), "munich-v5-loom");
        assert_eq!(slugify("***"), "workspace");
    }
}
