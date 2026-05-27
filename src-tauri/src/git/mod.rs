use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

pub fn run_git(root: impl AsRef<Path>, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root.as_ref())
        .args(args)
        .output()
        .map_err(|error| format!("failed to run git {}: {error}", args.join(" ")))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(format!("git {} failed: {detail}", args.join(" ")));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub fn clone_repo(url: &str, target: impl AsRef<Path>) -> Result<(), String> {
    let target = target.as_ref();
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    }
    let output = Command::new("git")
        .arg("clone")
        .arg(url)
        .arg(target)
        .output()
        .map_err(|error| format!("failed to run git clone: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!("git clone failed: {stderr}"))
    }
}

pub fn repo_root(root: impl AsRef<Path>) -> Result<PathBuf, String> {
    let root = root.as_ref();
    let output = run_git(root, &["rev-parse", "--show-toplevel"])?;
    Ok(PathBuf::from(output))
}

pub fn remote_url(root: impl AsRef<Path>) -> Option<String> {
    run_git(root, &["config", "--get", "remote.origin.url"])
        .ok()
        .filter(|value| !value.is_empty())
}

pub fn default_branch(root: impl AsRef<Path>) -> String {
    if let Ok(value) = run_git(
        &root,
        &["symbolic-ref", "refs/remotes/origin/HEAD", "--short"],
    ) {
        if let Some((_, branch)) = value.split_once('/') {
            if !branch.is_empty() {
                return branch.to_string();
            }
        }
    }
    run_git(root, &["symbolic-ref", "--short", "HEAD"])
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "main".to_string())
}

pub fn ref_exists(root: impl AsRef<Path>, reference: &str) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(root.as_ref())
        .args(["rev-parse", "--verify", "--quiet"])
        .arg(format!("{reference}^{{commit}}"))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

pub fn local_branch_exists(root: impl AsRef<Path>, branch: &str) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(root.as_ref())
        .args(["rev-parse", "--verify", "--quiet"])
        .arg(format!("refs/heads/{branch}^{{commit}}"))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

pub fn branch_is_merged_into_head(root: impl AsRef<Path>, branch: &str) -> bool {
    if !local_branch_exists(&root, branch) {
        return true;
    }
    let branch_ref = format!("refs/heads/{branch}");
    Command::new("git")
        .arg("-C")
        .arg(root.as_ref())
        .args(["merge-base", "--is-ancestor", &branch_ref, "HEAD"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

pub fn delete_local_branch(
    root: impl AsRef<Path>,
    branch: &str,
    force: bool,
) -> Result<(), String> {
    if !local_branch_exists(&root, branch) {
        return Ok(());
    }
    let flag = if force { "-D" } else { "-d" };
    run_git(root, &["branch", flag, branch]).map(|_| ())
}

pub fn worktree_add(
    repo_root: impl AsRef<Path>,
    worktree_path: impl AsRef<Path>,
    branch: &str,
    base_ref: &str,
) -> Result<(), String> {
    let worktree_path = worktree_path.as_ref();
    if let Some(parent) = worktree_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    }
    let path = worktree_path
        .to_str()
        .ok_or_else(|| format!("non-utf8 worktree path: {}", worktree_path.display()))?;
    run_git(
        repo_root,
        &["worktree", "add", "-b", branch, path, base_ref],
    )?;
    ensure_context_excluded(worktree_path)?;
    Ok(())
}

pub fn worktree_remove(worktree_path: impl AsRef<Path>, force: bool) -> Result<(), String> {
    let worktree_path = worktree_path.as_ref();
    let root = repo_root(worktree_path)?;
    let path = worktree_path
        .to_str()
        .ok_or_else(|| format!("non-utf8 worktree path: {}", worktree_path.display()))?;
    if force {
        run_git(root, &["worktree", "remove", "--force", path])?;
    } else {
        let status = status_porcelain(worktree_path)?;
        if !status.is_empty() {
            return Err(format!(
                "worktree has uncommitted changes: {}",
                worktree_path.display()
            ));
        }
        run_git(root, &["worktree", "remove", path])?;
    }
    Ok(())
}

pub fn status_porcelain(root: impl AsRef<Path>) -> Result<String, String> {
    run_git(root, &["status", "--porcelain"])
}

pub fn ensure_context_excluded(worktree_path: impl AsRef<Path>) -> Result<(), String> {
    let worktree_path = worktree_path.as_ref();
    let context_path = worktree_path.join(".context");
    fs::create_dir_all(&context_path)
        .map_err(|error| format!("failed to create {}: {error}", context_path.display()))?;

    let git_dir = run_git(worktree_path, &["rev-parse", "--git-dir"])?;
    let git_dir_path = {
        let path = PathBuf::from(git_dir);
        if path.is_absolute() {
            path
        } else {
            worktree_path.join(path)
        }
    };
    let info_dir = git_dir_path.join("info");
    fs::create_dir_all(&info_dir)
        .map_err(|error| format!("failed to create {}: {error}", info_dir.display()))?;
    let exclude = info_dir.join("exclude");
    let current = fs::read_to_string(&exclude).unwrap_or_default();
    if !current.lines().any(|line| line.trim() == ".context/") {
        let mut next = current;
        if !next.is_empty() && !next.ends_with('\n') {
            next.push('\n');
        }
        next.push_str(".context/\n");
        fs::write(&exclude, next)
            .map_err(|error| format!("failed to write {}: {error}", exclude.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        delete_local_branch, ensure_context_excluded, local_branch_exists, repo_root, run_git,
        worktree_add, worktree_remove,
    };
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn repo_root_finds_toplevel_from_child() {
        let root = temp_dir("repo-root");
        run_git(".", &["init", root.to_str().expect("utf8 temp path")]).expect("git init");
        let child = root.join("nested");
        fs::create_dir_all(&child).expect("create child");

        let found = repo_root(&child).expect("repo root");

        assert_eq!(found, fs::canonicalize(&root).expect("canonical root"));
        fs::remove_dir_all(root).expect("remove temp repo");
    }

    #[test]
    fn ensure_context_excluded_creates_context_and_git_exclude_entry() {
        let root = temp_dir("context-exclude");
        run_git(".", &["init", root.to_str().expect("utf8 temp path")]).expect("git init");

        ensure_context_excluded(&root).expect("exclude context");

        assert!(root.join(".context").is_dir());
        let exclude = fs::read_to_string(root.join(".git/info/exclude")).expect("read exclude");
        assert!(exclude.lines().any(|line| line == ".context/"));
        fs::remove_dir_all(root).expect("remove temp repo");
    }

    #[test]
    fn delete_local_branch_removes_branch_after_worktree_remove() {
        let root = initialized_repo("delete-branch");
        let worktree = temp_path("delete-branch-worktree");

        worktree_add(&root, &worktree, "loom/test/delete", "HEAD").expect("add worktree");
        worktree_remove(&worktree, false).expect("remove worktree");
        assert!(local_branch_exists(&root, "loom/test/delete"));

        delete_local_branch(&root, "loom/test/delete", false).expect("delete branch");

        assert!(!local_branch_exists(&root, "loom/test/delete"));
        fs::remove_dir_all(root).expect("remove temp repo");
    }

    #[test]
    fn delete_local_branch_requires_force_for_unmerged_branch() {
        let root = initialized_repo("delete-unmerged-branch");
        let worktree = temp_path("delete-unmerged-branch-worktree");

        worktree_add(&root, &worktree, "loom/test/unmerged", "HEAD").expect("add worktree");
        fs::write(worktree.join("change.txt"), "changed").expect("write change");
        run_git(&worktree, &["add", "change.txt"]).expect("add change");
        run_git(&worktree, &["commit", "-m", "change"]).expect("commit change");
        worktree_remove(&worktree, false).expect("remove worktree");

        let error = delete_local_branch(&root, "loom/test/unmerged", false)
            .expect_err("safe branch delete should fail");
        assert!(error.contains("not fully merged") || error.contains("not merged"));

        delete_local_branch(&root, "loom/test/unmerged", true).expect("force delete branch");
        assert!(!local_branch_exists(&root, "loom/test/unmerged"));
        fs::remove_dir_all(root).expect("remove temp repo");
    }

    fn initialized_repo(label: &str) -> PathBuf {
        let root = temp_dir(label);
        run_git(".", &["init", root.to_str().expect("utf8 temp path")]).expect("git init");
        run_git(&root, &["config", "user.email", "loom@example.com"]).expect("config email");
        run_git(&root, &["config", "user.name", "Loom"]).expect("config name");
        fs::write(root.join("README.md"), "test").expect("write readme");
        run_git(&root, &["add", "README.md"]).expect("add readme");
        run_git(&root, &["commit", "-m", "init"]).expect("commit readme");
        root
    }

    fn temp_dir(label: &str) -> PathBuf {
        let root = temp_path(label);
        fs::create_dir_all(&root).expect("create temp dir");
        root
    }

    fn temp_path(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("loom-git-test-{label}-{nanos}"))
    }
}
