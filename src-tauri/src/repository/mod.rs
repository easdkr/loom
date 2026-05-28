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

pub fn remove_workspace_worktree(
    workspace_id: &str,
    repo_id: &str,
    worktree_path: &str,
    force: bool,
) -> Result<WorkspaceMutationResponse, String> {
    let mut registry = load_v3_registry()?.unwrap_or_else(empty_registry);
    let workspace_index = registry
        .workspaces
        .iter()
        .position(|item| item.id == workspace_id)
        .ok_or_else(|| format!("workspace not found: {workspace_id}"))?;
    let workspace = registry.workspaces[workspace_index].clone();
    let binding = workspace
        .repo_bindings
        .iter()
        .find(|item| item.repo_id == repo_id && item.worktree_path == worktree_path)
        .cloned()
        .ok_or_else(|| format!("worktree binding not found: {repo_id} {worktree_path}"))?;

    if binding.binding_kind != WorkspaceRepoBindingKind::Worktree {
        return Err("only worktree bindings can be removed".to_string());
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

    git::worktree_remove(&binding.worktree_path, force)?;
    git::delete_local_branch(&repository.source_root, &binding.branch, force)?;

    if workspace.repo_bindings.len() == 1 {
        registry
            .workspaces
            .retain(|workspace| workspace.id != workspace_id);
        registry.open_tabs.retain(|id| id != workspace_id);
        if registry.active_workspace_id.as_deref() == Some(workspace_id) {
            registry.active_workspace_id = registry.open_tabs.first().cloned();
        }
    } else {
        let workspace = &mut registry.workspaces[workspace_index];
        workspace
            .repo_bindings
            .retain(|item| !(item.repo_id == repo_id && item.worktree_path == worktree_path));
        if workspace.active_repo_id == repo_id {
            workspace.active_repo_id = workspace
                .repo_bindings
                .first()
                .map(|item| item.repo_id.clone())
                .unwrap_or_default();
        }
        workspace.last_opened_at = now_millis();
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
    use super::{
        WorkspaceRepoBindingKind, create_workspace, name_from_git_url, register_local,
        remove_workspace_worktree, slugify,
    };
    use crate::git;
    use std::{
        fs,
        path::PathBuf,
        sync::{Mutex, MutexGuard},
        time::{SystemTime, UNIX_EPOCH},
    };

    static TEST_HOME_LOCK: Mutex<()> = Mutex::new(());

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

    #[test]
    fn create_workspace_allows_multiple_worktrees_for_same_repository() {
        let home = test_home("multiple-worktrees");
        let repo = initialized_repo("multiple-worktrees-repo");
        let repository = register_local(&repo).expect("register repository");

        let first = create_workspace(
            "First workspace",
            &[repository.id.clone()],
            None,
            std::slice::from_ref(&repository),
        )
        .expect("create first workspace");
        let second = create_workspace(
            "Second workspace",
            &[repository.id.clone()],
            None,
            std::slice::from_ref(&repository),
        )
        .expect("create second workspace");

        assert_eq!(second.registry.workspaces.len(), 2);
        let first_path = &first.registry.workspaces[0].repo_bindings[0].worktree_path;
        let second_path = &second.registry.workspaces[1].repo_bindings[0].worktree_path;
        assert_ne!(first_path, second_path);
        assert!(PathBuf::from(first_path).is_dir());
        assert!(PathBuf::from(second_path).is_dir());

        fs::remove_dir_all(repo).expect("remove repo");
        fs::remove_dir_all(&home.path).expect("remove home");
    }

    #[test]
    fn remove_workspace_worktree_deletes_clean_worktree_and_branch() {
        let home = test_home("remove-clean");
        let repo = initialized_repo("remove-clean-repo");
        let repository = register_local(&repo).expect("register repository");
        let created = create_workspace(
            "Clean workspace",
            &[repository.id.clone()],
            None,
            std::slice::from_ref(&repository),
        )
        .expect("create workspace");
        let workspace = &created.registry.workspaces[0];
        let binding = &workspace.repo_bindings[0];
        let branch = binding.branch.clone();
        let worktree_path = binding.worktree_path.clone();

        let response = remove_workspace_worktree(
            &workspace.id,
            &binding.repo_id,
            &binding.worktree_path,
            false,
        )
        .expect("remove worktree");

        assert!(response.registry.workspaces.is_empty());
        assert!(!PathBuf::from(&worktree_path).exists());
        assert!(!git::local_branch_exists(&repo, &branch));

        fs::remove_dir_all(repo).expect("remove repo");
        fs::remove_dir_all(&home.path).expect("remove home");
    }

    #[test]
    fn remove_workspace_worktree_blocks_dirty_worktree_without_force() {
        let home = test_home("remove-dirty");
        let repo = initialized_repo("remove-dirty-repo");
        let repository = register_local(&repo).expect("register repository");
        let created = create_workspace(
            "Dirty workspace",
            &[repository.id.clone()],
            None,
            std::slice::from_ref(&repository),
        )
        .expect("create workspace");
        let workspace = &created.registry.workspaces[0];
        let binding = &workspace.repo_bindings[0];
        fs::write(
            PathBuf::from(&binding.worktree_path).join("dirty.txt"),
            "dirty",
        )
        .expect("write dirty file");

        let error = remove_workspace_worktree(
            &workspace.id,
            &binding.repo_id,
            &binding.worktree_path,
            false,
        )
        .expect_err("dirty worktree should be blocked");

        assert!(error.contains("uncommitted changes"));
        assert!(PathBuf::from(&binding.worktree_path).exists());

        remove_workspace_worktree(
            &workspace.id,
            &binding.repo_id,
            &binding.worktree_path,
            true,
        )
        .expect("force remove dirty worktree");
        fs::remove_dir_all(repo).expect("remove repo");
        fs::remove_dir_all(&home.path).expect("remove home");
    }

    #[test]
    fn remove_workspace_worktree_preserves_workspace_for_partial_binding_delete() {
        let home = test_home("remove-partial");
        let first_repo = initialized_repo("remove-partial-first");
        let second_repo = initialized_repo("remove-partial-second");
        let first = register_local(&first_repo).expect("register first repository");
        let second = register_local(&second_repo).expect("register second repository");
        let created = create_workspace(
            "Multi repo workspace",
            &[first.id.clone(), second.id.clone()],
            None,
            &[first.clone(), second.clone()],
        )
        .expect("create workspace");
        let workspace = &created.registry.workspaces[0];
        let first_binding = workspace
            .repo_bindings
            .iter()
            .find(|binding| binding.repo_id == first.id)
            .expect("first binding");

        let response = remove_workspace_worktree(
            &workspace.id,
            &first_binding.repo_id,
            &first_binding.worktree_path,
            false,
        )
        .expect("remove first binding");
        let remaining = &response.registry.workspaces[0];

        assert_eq!(response.registry.workspaces.len(), 1);
        assert_eq!(remaining.repo_bindings.len(), 1);
        assert_eq!(remaining.repo_bindings[0].repo_id, second.id);
        assert_eq!(remaining.active_repo_id, second.id);
        assert_eq!(
            remaining.repo_bindings[0].binding_kind,
            WorkspaceRepoBindingKind::Worktree
        );

        remove_workspace_worktree(
            &remaining.id,
            &remaining.repo_bindings[0].repo_id,
            &remaining.repo_bindings[0].worktree_path,
            true,
        )
        .expect("cleanup remaining binding");
        fs::remove_dir_all(first_repo).expect("remove first repo");
        fs::remove_dir_all(second_repo).expect("remove second repo");
        fs::remove_dir_all(&home.path).expect("remove home");
    }

    struct TestHome {
        path: PathBuf,
        original_home: Option<std::ffi::OsString>,
        _guard: MutexGuard<'static, ()>,
    }

    impl Drop for TestHome {
        fn drop(&mut self) {
            unsafe {
                if let Some(original) = &self.original_home {
                    std::env::set_var("HOME", original);
                } else {
                    std::env::remove_var("HOME");
                }
            }
        }
    }

    fn test_home(label: &str) -> TestHome {
        let guard = TEST_HOME_LOCK.lock().expect("lock test home");
        let path = temp_path(label);
        fs::create_dir_all(&path).expect("create home");
        let original_home = std::env::var_os("HOME");
        unsafe {
            std::env::set_var("HOME", &path);
        }
        TestHome {
            path,
            original_home,
            _guard: guard,
        }
    }

    fn initialized_repo(label: &str) -> PathBuf {
        let root = temp_path(label);
        git::run_git(".", &["init", root.to_str().expect("utf8 temp path")]).expect("git init");
        git::run_git(&root, &["config", "user.email", "loom@example.com"]).expect("config email");
        git::run_git(&root, &["config", "user.name", "Loom"]).expect("config name");
        fs::write(root.join("README.md"), "test").expect("write readme");
        git::run_git(&root, &["add", "README.md"]).expect("add readme");
        git::run_git(&root, &["commit", "-m", "init"]).expect("commit readme");
        root
    }

    fn temp_path(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("loom-repository-test-{label}-{nanos}"))
    }
}
