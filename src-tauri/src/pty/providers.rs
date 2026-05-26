use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
};

const DEFAULT_COMPLETION_TIMEOUT_MS: u64 = 30 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS: u64 = 5 * 60 * 1000;
const DEFAULT_COLS: u16 = 220;
const DEFAULT_ROWS: u16 = 50;
pub const DEFAULT_SETTLE_MS: u64 = 800;
pub const DEFAULT_MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const LEGACY_AGENT_COMPLETION_PATTERN: &str = "(?m)(Task complete|Done|Finished|>\\s*$)";
const AGENT_COMPLETION_PATTERN: &str = "(?m)(Task complete|Done|Finished|>\\s*$|^[\\s*✢✳✽✻✣✶✱✦✧✩✪✫⚡+·•◦°]*[A-Za-z][A-Za-z -]{1,40}(?:ed|ing)\\s+for\\s+(?:\\d+m\\s*)?\\d+s\\s*$)";

pub const DEFAULT_PROVIDERS_TOML: &str = r#"[[providers]]
name = "shell"
type = "pty"
command = "/bin/zsh"
args = ["-lc"]
input_mode = "append-arg"
display_mode = "terminal"
completion_pattern = "(?m)^LOOM_EXIT:\\d+\\r?$"
error_pattern = ""
cols = 220
rows = 50
completion_timeout_ms = 120000
idle_timeout_ms = 30000
settle_ms = 200
max_output_bytes = 1048576
env = { FORCE_COLOR = "0", NO_COLOR = "1", TERM = "xterm-256color" }

[[providers]]
name = "claude-code"
type = "croxy"
command = "claude"
args = ["--permission-mode", "bypassPermissions"]
input_mode = "append-arg"
display_mode = "agent"
completion_pattern = "(?m)(Task complete|Done|Finished|>\\s*$|^[\\s*✢✳✽✻✣✶✱✦✧✩✪✫⚡+·•◦°]*[A-Za-z][A-Za-z -]{1,40}(?:ed|ing)\\s+for\\s+(?:\\d+m\\s*)?\\d+s\\s*$)"
error_pattern = "(?i)(rate.?limit|429 too many|usage limit|quota exceeded|context length exceeded)"
cols = 220
rows = 50
completion_timeout_ms = 1800000
idle_timeout_ms = 300000
settle_ms = 1200
max_output_bytes = 2097152
env = { FORCE_COLOR = "0", NO_COLOR = "1", TERM = "xterm-256color" }

[[providers]]
name = "codex"
type = "pty"
command = "codex"
args = []
input_mode = "append-arg"
display_mode = "agent"
completion_pattern = "(?m)(Task complete|Done|Finished|>\\s*$|^[\\s*✢✳✽✻✣✶✱✦✧✩✪✫⚡+·•◦°]*[A-Za-z][A-Za-z -]{1,40}(?:ed|ing)\\s+for\\s+(?:\\d+m\\s*)?\\d+s\\s*$)"
error_pattern = "(?i)(rate.?limit|429 too many|usage limit|quota exceeded|context length exceeded)"
cols = 220
rows = 50
completion_timeout_ms = 1800000
idle_timeout_ms = 300000
settle_ms = 1200
max_output_bytes = 2097152
env = { FORCE_COLOR = "0", NO_COLOR = "1", TERM = "xterm-256color" }

[[providers]]
name = "cursor"
type = "pty"
command = "cursor-agent"
args = []
input_mode = "stdin"
display_mode = "agent"
completion_pattern = "(?m)(Task complete|Done|Finished|>\\s*$|^[\\s*✢✳✽✻✣✶✱✦✧✩✪✫⚡+·•◦°]*[A-Za-z][A-Za-z -]{1,40}(?:ed|ing)\\s+for\\s+(?:\\d+m\\s*)?\\d+s\\s*$)"
error_pattern = "(?i)(rate.?limit|429 too many|usage limit|quota exceeded|context length exceeded)"
cols = 220
rows = 50
completion_timeout_ms = 1800000
idle_timeout_ms = 300000
settle_ms = 1200
max_output_bytes = 2097152
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
#[serde(rename_all = "kebab-case")]
pub enum ProviderDisplayMode {
    Agent,
    Terminal,
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
    pub error_pattern: String,
    #[serde(default)]
    pub input_mode: ProviderInputMode,
    #[serde(default)]
    pub display_mode: Option<ProviderDisplayMode>,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
    #[serde(default = "default_completion_timeout_ms")]
    pub completion_timeout_ms: u64,
    #[serde(default = "default_idle_timeout_ms")]
    pub idle_timeout_ms: u64,
    #[serde(default = "default_settle_ms")]
    pub settle_ms: u64,
    #[serde(default = "default_max_output_bytes")]
    pub max_output_bytes: usize,
}

impl ProviderConfig {
    pub fn effective_settle_ms(&self) -> u64 {
        if self.settle_ms == 0 {
            DEFAULT_SETTLE_MS
        } else {
            self.settle_ms
        }
    }

    pub fn effective_max_output_bytes(&self) -> usize {
        if self.max_output_bytes == 0 {
            DEFAULT_MAX_OUTPUT_BYTES
        } else {
            self.max_output_bytes.max(4096)
        }
    }
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

fn default_settle_ms() -> u64 {
    DEFAULT_SETTLE_MS
}

fn default_max_output_bytes() -> usize {
    DEFAULT_MAX_OUTPUT_BYTES
}

pub fn providers_config_path() -> PathBuf {
    loom_home().join("providers.toml")
}

pub fn provider_plugins_dir() -> PathBuf {
    loom_home().join("plugins").join("providers")
}

fn loom_home() -> PathBuf {
    env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".loom")
}

pub fn default_provider_configs() -> Result<Vec<ProviderConfig>, String> {
    parse_provider_toml(DEFAULT_PROVIDERS_TOML).map(|file| file.providers)
}

pub fn load_provider_configs() -> Result<Vec<ProviderConfig>, String> {
    load_provider_configs_with_override(None::<&Path>)
}

pub fn load_provider_configs_with_override(
    override_path: Option<impl AsRef<Path>>,
) -> Result<Vec<ProviderConfig>, String> {
    load_provider_configs_from_paths(
        &providers_config_path(),
        &provider_plugins_dir(),
        override_path.as_ref().map(|path| path.as_ref()),
    )
}

fn load_provider_configs_from_paths(
    global_path: &Path,
    plugin_dir: &Path,
    override_path: Option<&Path>,
) -> Result<Vec<ProviderConfig>, String> {
    let mut providers = default_provider_configs()?;

    for plugin in load_plugin_providers_from_dir(plugin_dir)? {
        merge_provider(&mut providers, plugin);
    }

    merge_providers_from_path(&mut providers, global_path)?;
    if let Some(path) = override_path {
        merge_providers_from_path(&mut providers, path)?;
    }
    normalize_provider_engines(&mut providers);

    Ok(providers)
}

fn merge_provider(providers: &mut Vec<ProviderConfig>, provider: ProviderConfig) {
    if let Some(index) = providers
        .iter()
        .position(|existing| existing.name == provider.name)
    {
        providers[index] = provider;
    } else {
        providers.push(provider);
    }
}

fn merge_providers_from_path(
    providers: &mut Vec<ProviderConfig>,
    path: &Path,
) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    let file = fs::read_to_string(path)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    let parsed = parse_provider_toml(&file)
        .map_err(|error| format!("failed to parse {}: {error}", path.display()))?;

    for provider in parsed.providers {
        merge_provider(providers, provider);
    }

    Ok(())
}

fn normalize_provider_engines(providers: &mut [ProviderConfig]) {
    for provider in providers {
        if provider.name == "claude-code" && provider.command == "claude" {
            provider.provider_type = "croxy".to_string();
            provider.display_mode = Some(ProviderDisplayMode::Agent);
        }
    }
}

fn load_plugin_providers_from_dir(dir: &Path) -> Result<Vec<ProviderConfig>, String> {
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut collected = Vec::new();
    let entries =
        fs::read_dir(dir).map_err(|error| format!("failed to read {}: {error}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("plugin entry read failed: {error}"))?;
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("toml") {
            continue;
        }
        let raw = fs::read_to_string(&path)
            .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
        let file = parse_provider_toml(&raw)
            .map_err(|error| format!("failed to parse {}: {error}", path.display()))?;
        collected.extend(file.providers);
    }
    Ok(collected)
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

    if is_codex_exec_provider(provider) {
        return Err(
            "codex exec is forbidden for Loom PTY execution; use interactive codex instead"
                .to_string(),
        );
    }

    Ok(())
}

fn parse_provider_toml(source: &str) -> Result<ProviderConfigFile, String> {
    let mut file: ProviderConfigFile = toml::from_str(source).map_err(|error| error.to_string())?;
    for provider in &mut file.providers {
        if provider.display_mode.is_none() {
            provider.display_mode = Some(default_display_mode_for_provider(
                &provider.name,
                &provider.command,
            ));
        }
        if matches!(provider.display_mode, Some(ProviderDisplayMode::Agent))
            && provider.completion_pattern == LEGACY_AGENT_COMPLETION_PATTERN
        {
            provider.completion_pattern = AGENT_COMPLETION_PATTERN.to_string();
        }
    }
    Ok(file)
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

fn is_codex_exec_provider(provider: &ProviderConfig) -> bool {
    let command = provider
        .command
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(provider.command.as_str());

    command == "codex" && provider.args.first().map(String::as_str) == Some("exec")
}

fn default_display_mode_for_provider(name: &str, command: &str) -> ProviderDisplayMode {
    let identity = format!("{name} {command}").to_ascii_lowercase();
    if identity.contains("claude") || identity.contains("codex") || identity.contains("cursor") {
        ProviderDisplayMode::Agent
    } else {
        ProviderDisplayMode::Terminal
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ProviderDisplayMode, ProviderInputMode, default_provider_configs,
        load_provider_configs_from_paths, providers_config_path, validate_provider_for_execution,
    };
    use regex::Regex;
    use std::{
        fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
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
        assert_eq!(shell.display_mode, Some(ProviderDisplayMode::Terminal));
    }

    #[test]
    fn providers_default_to_compatible_display_modes() {
        let providers = default_provider_configs().unwrap();

        let claude = providers
            .iter()
            .find(|provider| provider.name == "claude-code")
            .unwrap();
        assert_eq!(claude.display_mode, Some(ProviderDisplayMode::Agent));

        let codex = providers
            .iter()
            .find(|provider| provider.name == "codex")
            .unwrap();
        assert_eq!(codex.display_mode, Some(ProviderDisplayMode::Agent));

        let cursor = providers
            .iter()
            .find(|provider| provider.name == "cursor")
            .unwrap();
        assert_eq!(cursor.display_mode, Some(ProviderDisplayMode::Agent));
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
    fn default_agent_completion_matches_elapsed_status_with_minutes() {
        let claude = default_provider_configs()
            .unwrap()
            .into_iter()
            .find(|provider| provider.name == "claude-code")
            .unwrap();
        let pattern = Regex::new(&claude.completion_pattern).unwrap();

        assert!(pattern.is_match("* Cogitated for 1m 24s"));
        assert!(pattern.is_match("✻ Crunching for 2s"));
    }

    #[test]
    fn rejects_claude_print_even_from_overrides() {
        let mut claude = default_provider_configs()
            .unwrap()
            .into_iter()
            .find(|provider| provider.name == "claude-code")
            .unwrap();
        claude.args = vec!["--print".to_string()];

        assert!(
            validate_provider_for_execution(&claude)
                .unwrap_err()
                .contains("forbidden")
        );
    }

    #[test]
    fn default_codex_provider_never_uses_exec_mode() {
        let codex = default_provider_configs()
            .unwrap()
            .into_iter()
            .find(|provider| provider.name == "codex")
            .unwrap();

        assert!(!codex.args.iter().any(|arg| arg == "exec"));
        validate_provider_for_execution(&codex).unwrap();
    }

    #[test]
    fn rejects_codex_exec_even_from_overrides() {
        let mut codex = default_provider_configs()
            .unwrap()
            .into_iter()
            .find(|provider| provider.name == "codex")
            .unwrap();
        codex.args = vec!["exec".to_string(), "--sandbox".to_string()];

        assert!(
            validate_provider_for_execution(&codex)
                .unwrap_err()
                .contains("forbidden")
        );
    }

    #[test]
    fn override_path_has_highest_precedence_after_global_and_plugins() {
        let root = temp_project_root("provider-override");
        let global_path = root.join("providers.toml");
        let plugin_dir = root.join("plugins");
        let override_path = root.join("project-providers.toml");

        fs::create_dir_all(&plugin_dir).expect("create plugin dir");
        fs::write(
            plugin_dir.join("plugin.toml"),
            provider_toml("shell", "/plugin-shell"),
        )
        .expect("write plugin provider");
        fs::write(&global_path, provider_toml("shell", "/global-shell"))
            .expect("write global provider");
        fs::write(&override_path, provider_toml("shell", "/project-shell"))
            .expect("write project provider");

        let shell =
            load_provider_configs_from_paths(&global_path, &plugin_dir, Some(&override_path))
                .expect("load providers")
                .into_iter()
                .find(|provider| provider.name == "shell")
                .expect("shell provider");

        assert_eq!(shell.command, "/project-shell");

        fs::remove_dir_all(root).expect("remove temp provider root");
    }

    #[test]
    fn global_override_wins_when_project_override_missing() {
        let root = temp_project_root("provider-global");
        let global_path = root.join("providers.toml");
        let plugin_dir = root.join("plugins");
        let missing_override = root.join("missing.toml");

        fs::create_dir_all(&plugin_dir).expect("create plugin dir");
        fs::write(
            plugin_dir.join("plugin.toml"),
            provider_toml("shell", "/plugin-shell"),
        )
        .expect("write plugin provider");
        fs::write(&global_path, provider_toml("shell", "/global-shell"))
            .expect("write global provider");

        let shell =
            load_provider_configs_from_paths(&global_path, &plugin_dir, Some(&missing_override))
                .expect("load providers")
                .into_iter()
                .find(|provider| provider.name == "shell")
                .expect("shell provider");

        assert_eq!(shell.command, "/global-shell");

        fs::remove_dir_all(root).expect("remove temp provider root");
    }

    #[test]
    fn legacy_agent_completion_pattern_is_upgraded_for_overrides() {
        let root = temp_project_root("provider-legacy-completion");
        let global_path = root.join("providers.toml");
        let plugin_dir = root.join("plugins");
        fs::create_dir_all(&plugin_dir).expect("create plugin dir");
        fs::write(
            &global_path,
            r#"[[providers]]
name = "claude-code"
type = "pty"
command = "claude"
args = ["--permission-mode", "bypassPermissions"]
input_mode = "append-arg"
display_mode = "agent"
completion_pattern = "(?m)(Task complete|Done|Finished|>\\s*$)"
"#,
        )
        .expect("write legacy claude provider");

        let claude =
            load_provider_configs_from_paths(&global_path, &plugin_dir, None::<&std::path::Path>)
                .expect("load providers")
                .into_iter()
                .find(|provider| provider.name == "claude-code")
                .expect("claude provider");
        let pattern = Regex::new(&claude.completion_pattern).unwrap();

        assert_eq!(claude.provider_type, "croxy");
        assert_eq!(claude.display_mode, Some(ProviderDisplayMode::Agent));
        assert!(pattern.is_match("* Cogitated for 1m 24s"));

        fs::remove_dir_all(root).expect("remove temp provider root");
    }

    fn provider_toml(name: &str, command: &str) -> String {
        format!(
            r#"[[providers]]
name = "{name}"
type = "pty"
command = "{command}"
args = []
input_mode = "stdin"
"#
        )
    }

    #[test]
    fn missing_display_mode_infers_provider_defaults() {
        let shell = load_provider_configs_from_paths(
            PathBuf::from("/definitely-missing-global.toml").as_path(),
            PathBuf::from("/definitely-missing-plugins").as_path(),
            None::<&std::path::Path>,
        )
        .unwrap()
        .into_iter()
        .find(|provider| provider.name == "shell")
        .unwrap();

        assert_eq!(shell.display_mode, Some(ProviderDisplayMode::Terminal));

        let root = temp_project_root("provider-display-mode");
        let global_path = root.join("providers.toml");
        let plugin_dir = root.join("plugins");
        fs::create_dir_all(&plugin_dir).expect("create plugin dir");
        fs::write(
            &global_path,
            r#"[[providers]]
name = "custom-codex"
type = "pty"
command = "codex"
args = []
input_mode = "stdin"
"#,
        )
        .expect("write provider without display mode");

        let provider =
            load_provider_configs_from_paths(&global_path, &plugin_dir, None::<&std::path::Path>)
                .expect("load providers")
                .into_iter()
                .find(|provider| provider.name == "custom-codex")
                .expect("custom codex provider");

        assert_eq!(provider.display_mode, Some(ProviderDisplayMode::Agent));

        fs::write(
            &global_path,
            r#"[[providers]]
name = "custom-claude"
type = "pty"
command = "claude"
args = []
input_mode = "stdin"
"#,
        )
        .expect("write claude provider without display mode");

        let provider =
            load_provider_configs_from_paths(&global_path, &plugin_dir, None::<&std::path::Path>)
                .expect("load providers")
                .into_iter()
                .find(|provider| provider.name == "custom-claude")
                .expect("custom claude provider");

        assert_eq!(provider.display_mode, Some(ProviderDisplayMode::Agent));

        fs::remove_dir_all(root).expect("remove temp provider root");
    }

    fn temp_project_root(label: &str) -> PathBuf {
        let root = temp_path(label);
        fs::create_dir_all(&root).expect("create temp provider root");
        root
    }

    fn temp_path(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time after epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("loom-provider-test-{label}-{nanos}"))
    }
}
