use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, env, fs, path::PathBuf};

const DEFAULT_COMPLETION_TIMEOUT_MS: u64 = 30 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS: u64 = 5 * 60 * 1000;
const DEFAULT_COLS: u16 = 220;
const DEFAULT_ROWS: u16 = 50;

pub const DEFAULT_PROVIDERS_TOML: &str = r#"[[providers]]
name = "shell"
type = "pty"
command = "/bin/zsh"
args = ["-lc"]
input_mode = "append-arg"
completion_pattern = "(?m)^LOOM_EXIT:\\d+\\r?$"
cols = 220
rows = 50
completion_timeout_ms = 120000
idle_timeout_ms = 30000
env = { FORCE_COLOR = "0", NO_COLOR = "1", TERM = "xterm-256color" }

[[providers]]
name = "claude-code"
type = "pty"
command = "claude"
args = ["--permission-mode", "bypassPermissions"]
input_mode = "append-arg"
completion_pattern = "(?m)(Task complete|Done|Finished|>\\s*$)"
cols = 220
rows = 50
completion_timeout_ms = 1800000
idle_timeout_ms = 300000
env = { FORCE_COLOR = "0", NO_COLOR = "1", TERM = "xterm-256color" }

[[providers]]
name = "codex"
type = "pty"
command = "codex"
args = ["exec", "--sandbox", "workspace-write", "--skip-git-repo-check", "--color", "never"]
input_mode = "append-arg"
completion_pattern = "(?m)(Task complete|Done|Finished)"
cols = 220
rows = 50
completion_timeout_ms = 1800000
idle_timeout_ms = 300000
env = { FORCE_COLOR = "0", NO_COLOR = "1", TERM = "xterm-256color" }

[[providers]]
name = "cursor"
type = "pty"
command = "cursor-agent"
args = []
input_mode = "stdin"
completion_pattern = "(?m)(Task complete|Done|Finished|>\\s*$)"
cols = 220
rows = 50
completion_timeout_ms = 1800000
idle_timeout_ms = 300000
env = { FORCE_COLOR = "0", NO_COLOR = "1", TERM = "xterm-256color" }
"#;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderInputMode {
    AppendArg,
    #[default]
    Stdin,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderConfig {
    pub name: String,
    #[serde(rename = "type")]
    pub provider_type: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub completion_pattern: String,
    #[serde(default)]
    pub input_mode: ProviderInputMode,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
    #[serde(default = "default_completion_timeout_ms")]
    pub completion_timeout_ms: u64,
    #[serde(default = "default_idle_timeout_ms")]
    pub idle_timeout_ms: u64,
}

#[derive(Debug, Deserialize)]
struct ProviderConfigFile {
    #[serde(default)]
    providers: Vec<ProviderConfig>,
}

fn default_cols() -> u16 {
    DEFAULT_COLS
}

fn default_rows() -> u16 {
    DEFAULT_ROWS
}

fn default_completion_timeout_ms() -> u64 {
    DEFAULT_COMPLETION_TIMEOUT_MS
}

fn default_idle_timeout_ms() -> u64 {
    DEFAULT_IDLE_TIMEOUT_MS
}

pub fn providers_config_path() -> PathBuf {
    env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".loom")
        .join("providers.toml")
}

pub fn default_provider_configs() -> Result<Vec<ProviderConfig>, String> {
    parse_provider_toml(DEFAULT_PROVIDERS_TOML).map(|file| file.providers)
}

pub fn load_provider_configs() -> Result<Vec<ProviderConfig>, String> {
    let mut providers = default_provider_configs()?;
    let path = providers_config_path();

    if !path.exists() {
        return Ok(providers);
    }

    let file = fs::read_to_string(&path)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    let user_providers = parse_provider_toml(&file)
        .map_err(|error| format!("failed to parse {}: {error}", path.display()))?
        .providers;

    for provider in user_providers {
        if let Some(index) = providers
            .iter()
            .position(|existing| existing.name == provider.name)
        {
            providers[index] = provider;
        } else {
            providers.push(provider);
        }
    }

    Ok(providers)
}

pub fn find_provider(provider_name: &str) -> Result<ProviderConfig, String> {
    load_provider_configs()?
        .into_iter()
        .find(|provider| provider.name == provider_name)
        .ok_or_else(|| format!("unknown provider: {provider_name}"))
}

pub fn validate_provider_for_execution(provider: &ProviderConfig) -> Result<(), String> {
    if is_claude_print_provider(provider) {
        return Err(
            "claude --print is forbidden for Loom PTY execution; use interactive claude instead"
                .to_string(),
        );
    }

    Ok(())
}

fn parse_provider_toml(source: &str) -> Result<ProviderConfigFile, String> {
    toml::from_str(source).map_err(|error| error.to_string())
}

fn is_claude_print_provider(provider: &ProviderConfig) -> bool {
    let command = provider
        .command
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(provider.command.as_str());

    command == "claude"
        && provider
            .args
            .iter()
            .any(|arg| matches!(arg.as_str(), "--print" | "-p"))
}

#[cfg(test)]
mod tests {
    use super::{
        default_provider_configs, providers_config_path, validate_provider_for_execution,
        ProviderInputMode,
    };

    #[test]
    fn default_registry_contains_phase_one_providers() {
        let names = default_provider_configs()
            .unwrap()
            .into_iter()
            .map(|provider| provider.name)
            .collect::<Vec<_>>();

        assert!(names.contains(&"shell".to_string()));
        assert!(names.contains(&"claude-code".to_string()));
        assert!(names.contains(&"codex".to_string()));
        assert!(names.contains(&"cursor".to_string()));
    }

    #[test]
    fn default_shell_accepts_prompt_as_argument() {
        let shell = default_provider_configs()
            .unwrap()
            .into_iter()
            .find(|provider| provider.name == "shell")
            .unwrap();

        assert_eq!(shell.input_mode, ProviderInputMode::AppendArg);
    }

    #[test]
    fn provider_path_uses_loom_home() {
        assert!(providers_config_path().ends_with(".loom/providers.toml"));
    }

    #[test]
    fn default_claude_provider_never_uses_print_mode() {
        let claude = default_provider_configs()
            .unwrap()
            .into_iter()
            .find(|provider| provider.name == "claude-code")
            .unwrap();

        assert!(!claude.args.contains(&"--print".to_string()));
        assert!(!claude.args.contains(&"-p".to_string()));
        assert!(claude.args.contains(&"--permission-mode".to_string()));
        assert!(claude.args.contains(&"bypassPermissions".to_string()));
        validate_provider_for_execution(&claude).unwrap();
    }

    #[test]
    fn rejects_claude_print_even_from_overrides() {
        let mut claude = default_provider_configs()
            .unwrap()
            .into_iter()
            .find(|provider| provider.name == "claude-code")
            .unwrap();
        claude.args = vec!["--print".to_string()];

        assert!(validate_provider_for_execution(&claude)
            .unwrap_err()
            .contains("forbidden"));
    }
}
