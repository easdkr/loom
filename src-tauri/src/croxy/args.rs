use anyhow::{Result, bail};
use std::collections::HashSet;
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputFormat {
    Text,
    Json,
    StreamJson,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputFormat {
    Text,
    StreamJson,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Args {
    pub output_format: OutputFormat,
    pub input_format: InputFormat,
    pub verbose: bool,
    pub include_partial: bool,
    pub replay_user_messages: bool,
    pub max_turns: Option<u32>,
    pub max_budget_usd: Option<f64>,
    pub prompt: Option<String>,
    pub read_prompt_from_stdin: bool,
    pub claude_args: Vec<String>,
    pub cwd: PathBuf,
}

impl Args {
    pub fn should_print_help_for_empty_tty(&self, stdin_is_tty: bool) -> bool {
        self.prompt.is_none()
            && !self.read_prompt_from_stdin
            && self.input_format == InputFormat::Text
            && stdin_is_tty
    }
}

pub fn parse_args(argv: impl IntoIterator<Item = String>) -> Result<Option<Args>> {
    let argv: Vec<String> = argv.into_iter().collect();
    let mut args = Args {
        output_format: OutputFormat::Text,
        input_format: InputFormat::Text,
        verbose: false,
        include_partial: false,
        replay_user_messages: false,
        max_turns: None,
        max_budget_usd: None,
        prompt: None,
        read_prompt_from_stdin: false,
        claude_args: Vec::new(),
        cwd: std::env::current_dir()?,
    };

    let scalar_value_flags = scalar_value_flags();
    let optional_value_flags = optional_value_flags();
    let variadic_value_flags = variadic_value_flags();
    let boolean_flags = boolean_flags();
    let mut prompt: Option<String> = None;
    let mut i = 0;

    while i < argv.len() {
        let arg = &argv[i];
        match arg.as_str() {
            "-h" | "--help" => {
                print_help();
                return Ok(None);
            }
            "-v" | "--version" => {
                println!("croxy {}", env!("CARGO_PKG_VERSION"));
                return Ok(None);
            }
            "-p" | "--print" => {
                i += 1;
            }
            "-" => {
                if prompt.is_none() {
                    args.read_prompt_from_stdin = true;
                }
                i += 1;
            }
            "--verbose" => {
                args.verbose = true;
                i += 1;
            }
            "--include-partial-messages" => {
                args.include_partial = true;
                i += 1;
            }
            "--include-hook-events" => {
                i += 1;
            }
            "--replay-user-messages" => {
                args.replay_user_messages = true;
                i += 1;
            }
            "--output-format" => {
                i += 1;
                args.output_format = parse_output_format(argv.get(i).map(String::as_str))?;
                i += 1;
            }
            "--input-format" => {
                i += 1;
                args.input_format = parse_input_format(argv.get(i).map(String::as_str))?;
                i += 1;
            }
            "--max-turns" => {
                i += 1;
                args.max_turns = Some(parse_positive_integer("--max-turns", argv.get(i))?);
                i += 1;
            }
            "--max-budget-usd" => {
                i += 1;
                args.max_budget_usd = Some(parse_positive_number("--max-budget-usd", argv.get(i))?);
                i += 1;
            }
            _ if arg.starts_with("--output-format=") => {
                args.output_format = parse_output_format(Some(&arg["--output-format=".len()..]))?;
                i += 1;
            }
            _ if arg.starts_with("--input-format=") => {
                args.input_format = parse_input_format(Some(&arg["--input-format=".len()..]))?;
                i += 1;
            }
            _ if arg.starts_with("--max-turns=") => {
                args.max_turns = Some(parse_positive_integer_value(
                    "--max-turns",
                    &arg["--max-turns=".len()..],
                )?);
                i += 1;
            }
            _ if arg.starts_with("--max-budget-usd=") => {
                args.max_budget_usd = Some(parse_positive_number_value(
                    "--max-budget-usd",
                    &arg["--max-budget-usd=".len()..],
                )?);
                i += 1;
            }
            "--" => {
                prompt = argv.get(i + 1).cloned();
                break;
            }
            _ if arg.starts_with('-') => {
                let flag_name = arg.split_once('=').map_or(arg.as_str(), |(flag, _)| flag);
                if is_known_claude_flag(
                    arg,
                    &scalar_value_flags,
                    &optional_value_flags,
                    &variadic_value_flags,
                    &boolean_flags,
                ) {
                    if boolean_flags.contains(flag_name) && arg.contains('=') {
                        bail!("unknown option '{arg}'");
                    }
                    args.claude_args.push(arg.clone());
                    i = consume_claude_values(
                        &argv,
                        i,
                        &mut args.claude_args,
                        &scalar_value_flags,
                        &optional_value_flags,
                        &variadic_value_flags,
                    )?;
                } else {
                    bail!("unknown option '{arg}'");
                }
            }
            _ => {
                if prompt.is_none() {
                    prompt = Some(arg.clone());
                }
                i += 1;
            }
        }
    }

    args.prompt = prompt;
    if args.output_format == OutputFormat::StreamJson {
        args.verbose = true;
    }
    Ok(Some(args))
}

pub fn print_help() {
    println!(
        "Usage: croxy [options] [prompt]\n\n\
         Options:\n\
           -p, --print                         accepted for claude -p compatibility\n\
               --input-format <text|stream-json>\n\
               --output-format <text|json|stream-json>\n\
               --include-partial-messages\n\
               --include-hook-events\n\
               --replay-user-messages\n\
               --max-turns <n>\n\
               --max-budget-usd <usd>\n\
           -h, --help\n\
           -v, --version\n\n\
         Claude pass-through options:\n\
               --model <model>                 Model for the current session, e.g. sonnet, opus, or full model name\n\
               --effort <level>                Effort level for the current session: low, medium, high, max\n\
               --fallback-model <model>        Fallback model when the default model is overloaded\n\
               --permission-mode <mode>        Permission mode: acceptEdits, auto, bypassPermissions, default, dontAsk, plan\n\
               --allowedTools, --allowed-tools <tools...>\n\
               --disallowedTools, --disallowed-tools <tools...>\n\
               --add-dir <directories...>\n\
               --mcp-config <configs...>\n\n\
         Other known Claude CLI options are forwarded when supported by croxy's parser."
    );
}

fn parse_output_format(value: Option<&str>) -> Result<OutputFormat> {
    match value {
        Some("text") => Ok(OutputFormat::Text),
        Some("json") => Ok(OutputFormat::Json),
        Some("stream-json") => Ok(OutputFormat::StreamJson),
        Some(value) => bail!("Invalid --output-format: {}", missing_label(value)),
        None => bail!("Invalid --output-format: (missing)"),
    }
}

fn parse_input_format(value: Option<&str>) -> Result<InputFormat> {
    match value {
        Some("text") => Ok(InputFormat::Text),
        Some("stream-json") => Ok(InputFormat::StreamJson),
        Some(value) => bail!("Invalid --input-format: {}", missing_label(value)),
        None => bail!("Invalid --input-format: (missing)"),
    }
}

fn parse_positive_integer(flag: &str, value: Option<&String>) -> Result<u32> {
    parse_positive_integer_value(flag, value.map(String::as_str).unwrap_or(""))
}

fn parse_positive_integer_value(flag: &str, value: &str) -> Result<u32> {
    let parsed = value.parse::<u32>().ok().filter(|value| *value > 0);
    parsed.ok_or_else(|| anyhow::anyhow!("Invalid {flag}: {}", missing_label(value)))
}

fn parse_positive_number(flag: &str, value: Option<&String>) -> Result<f64> {
    parse_positive_number_value(flag, value.map(String::as_str).unwrap_or(""))
}

fn parse_positive_number_value(flag: &str, value: &str) -> Result<f64> {
    let parsed = value.parse::<f64>().ok().filter(|value| *value > 0.0);
    parsed.ok_or_else(|| anyhow::anyhow!("Invalid {flag}: {}", missing_label(value)))
}

fn missing_label(value: &str) -> &str {
    if value.is_empty() { "(missing)" } else { value }
}

fn is_known_claude_flag(
    arg: &str,
    scalar_value_flags: &HashSet<&'static str>,
    optional_value_flags: &HashSet<&'static str>,
    variadic_value_flags: &HashSet<&'static str>,
    boolean_flags: &HashSet<&'static str>,
) -> bool {
    let flag = arg.split_once('=').map_or(arg, |(flag, _)| flag);
    scalar_value_flags.contains(flag)
        || optional_value_flags.contains(flag)
        || variadic_value_flags.contains(flag)
        || boolean_flags.contains(flag)
}

fn consume_claude_values(
    argv: &[String],
    mut i: usize,
    claude_args: &mut Vec<String>,
    scalar_value_flags: &HashSet<&'static str>,
    optional_value_flags: &HashSet<&'static str>,
    variadic_value_flags: &HashSet<&'static str>,
) -> Result<usize> {
    let flag_name = argv[i]
        .split_once('=')
        .map_or(argv[i].as_str(), |(flag, _)| flag);
    if argv[i].contains('=') {
        return Ok(i + 1);
    }

    if variadic_value_flags.contains(flag_name) {
        let start = i;
        while argv.get(i + 1).is_some_and(|arg| !arg.starts_with('-')) {
            i += 1;
            claude_args.push(argv[i].clone());
        }
        if i == start {
            bail!("{}", missing_claude_value_message(flag_name));
        }
        return Ok(i + 1);
    }

    if scalar_value_flags.contains(flag_name) {
        if argv.get(i + 1).is_none_or(|arg| arg.starts_with('-')) {
            bail!("{}", missing_claude_value_message(flag_name));
        }
        i += 1;
        claude_args.push(argv[i].clone());
        return Ok(i + 1);
    }

    if optional_value_flags.contains(flag_name)
        && argv.get(i + 1).is_some_and(|arg| !arg.starts_with('-'))
    {
        i += 1;
        claude_args.push(argv[i].clone());
    }

    Ok(i + 1)
}

fn missing_claude_value_message(flag_name: &str) -> String {
    if flag_name == "--allowedTools" || flag_name == "--allowed-tools" {
        return "error: option '--allowedTools, --allowed-tools <tools...>' argument missing"
            .to_string();
    }
    if flag_name == "--disallowedTools" || flag_name == "--disallowed-tools" {
        return "error: option '--disallowedTools, --disallowed-tools <tools...>' argument missing"
            .to_string();
    }
    let label = claude_value_label(flag_name).unwrap_or("value");
    format!("error: option '{flag_name} <{label}>' argument missing")
}

fn claude_value_label(flag_name: &str) -> Option<&'static str> {
    Some(match flag_name {
        "--model" => "model",
        "--permission-mode" => "mode",
        "--system-prompt" => "prompt",
        "--system-prompt-file" => "file",
        "--append-system-prompt" => "prompt",
        "--append-system-prompt-file" => "file",
        "--session-id" => "uuid",
        "--effort" => "level",
        "--agent" => "agent",
        "--agents" => "json",
        "--name" | "-n" => "name",
        "--setting-sources" => "sources",
        "--settings" => "file-or-json",
        "--fallback-model" => "model",
        "--permission-prompt-tool" => "tool",
        "--max-thinking-tokens" => "tokens",
        "--output-style" => "style",
        "--debug-file" => "path",
        "--json-schema" => "schema",
        "--remote-control-session-name-prefix" => "prefix",
        "--plugin-dir" => "path",
        "--plugin-url" => "url",
        "--thinking" => "mode",
        "--task-budget" => "tokens",
        "--prefill" => "text",
        "--deep-link-repo" => "slug",
        "--deep-link-last-fetch" => "ms",
        "--resume-session-at" => "message id",
        "--rewind-files" => "user-message-id",
        "--workload" => "tag",
        "--advisor" => "model",
        "--messaging-socket-path" => "path",
        "--agent-id" => "id",
        "--agent-name" => "name",
        "--team-name" => "name",
        "--agent-color" => "color",
        "--parent-session-id" => "id",
        "--teammate-mode" => "mode",
        "--agent-type" => "type",
        "--sdk-url" => "url",
        "--add-dir" => "directories...",
        "--mcp-config" => "configs...",
        "--betas" => "betas...",
        "--file" => "specs...",
        "--tools" => "tools...",
        _ => return None,
    })
}

fn scalar_value_flags() -> HashSet<&'static str> {
    [
        "--model",
        "--permission-mode",
        "--system-prompt",
        "--system-prompt-file",
        "--append-system-prompt",
        "--append-system-prompt-file",
        "--session-id",
        "--effort",
        "--agent",
        "--agents",
        "--name",
        "-n",
        "--setting-sources",
        "--settings",
        "--fallback-model",
        "--permission-prompt-tool",
        "--max-thinking-tokens",
        "--output-style",
        "--debug-file",
        "--json-schema",
        "--remote-control-session-name-prefix",
        "--plugin-dir",
        "--plugin-url",
        "--thinking",
        "--task-budget",
        "--prefill",
        "--deep-link-repo",
        "--deep-link-last-fetch",
        "--resume-session-at",
        "--rewind-files",
        "--workload",
        "--advisor",
        "--messaging-socket-path",
        "--agent-id",
        "--agent-name",
        "--team-name",
        "--agent-color",
        "--parent-session-id",
        "--teammate-mode",
        "--agent-type",
        "--sdk-url",
    ]
    .into_iter()
    .collect()
}

fn optional_value_flags() -> HashSet<&'static str> {
    [
        "--resume",
        "-r",
        "--debug",
        "-d",
        "--from-pr",
        "--remote-control",
        "--rc",
        "--worktree",
        "-w",
        "--teleport",
        "--remote",
        "--tasks",
    ]
    .into_iter()
    .collect()
}

fn variadic_value_flags() -> HashSet<&'static str> {
    [
        "--add-dir",
        "--mcp-config",
        "--betas",
        "--file",
        "--tools",
        "--allowed-tools",
        "--allowedTools",
        "--disallowed-tools",
        "--disallowedTools",
        "--channels",
        "--dangerously-load-development-channels",
    ]
    .into_iter()
    .collect()
}

fn boolean_flags() -> HashSet<&'static str> {
    [
        "--bare",
        "--continue",
        "-c",
        "--allow-dangerously-skip-permissions",
        "--dangerously-skip-permissions",
        "--strict-mcp-config",
        "--fork-session",
        "--no-session-persistence",
        "--disable-slash-commands",
        "--mcp-debug",
        "--ide",
        "--chrome",
        "--no-chrome",
        "--brief",
        "--tmux",
        "-d2e",
        "--debug-to-stderr",
        "--init",
        "--init-only",
        "--maintenance",
        "--enable-auth-status",
        "--deep-link-origin",
        "--plan-mode-required",
        "--delegate-permissions",
        "--dangerously-skip-permissions-with-classifiers",
        "--afk",
        "--agent-teams",
        "--enable-auto-mode",
        "--proactive",
        "--assistant",
        "--hard-fail",
    ]
    .into_iter()
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(argv: &[&str]) -> Args {
        parse_args(argv.iter().map(|arg| arg.to_string()))
            .unwrap()
            .unwrap()
    }

    #[test]
    fn parses_prompt_and_croxy_formats() {
        let args = parse(&[
            "-p",
            "--input-format",
            "stream-json",
            "--output-format=stream-json",
            "hello",
        ]);

        assert_eq!(args.input_format, InputFormat::StreamJson);
        assert_eq!(args.output_format, OutputFormat::StreamJson);
        assert_eq!(args.prompt.as_deref(), Some("hello"));
    }

    #[test]
    fn preserves_known_claude_flags() {
        let args = parse(&[
            "--model",
            "sonnet",
            "--dangerously-skip-permissions",
            "--allowedTools",
            "Bash",
            "Read",
            "explain",
        ]);

        assert_eq!(
            args.claude_args,
            vec![
                "--model",
                "sonnet",
                "--dangerously-skip-permissions",
                "--allowedTools",
                "Bash",
                "Read",
                "explain"
            ]
        );
        assert_eq!(args.prompt, None);
    }

    #[test]
    fn rejects_unknown_options() {
        let err = parse_args(["--nope".to_string()]).unwrap_err();
        assert!(err.to_string().contains("unknown option"));
    }

    #[test]
    fn rejects_boolean_claude_flags_with_values() {
        let err = parse_args(["--bare=true".to_string()]).unwrap_err();
        assert!(err.to_string().contains("unknown option"));
    }

    #[test]
    fn stream_json_output_enables_verbose_for_claude_compatibility() {
        let args = parse(&["--output-format", "stream-json", "hello"]);

        assert!(args.verbose);
    }

    #[test]
    fn double_dash_uses_next_arg_as_prompt() {
        let args = parse(&["--", "hello", "ignored"]);

        assert_eq!(args.prompt.as_deref(), Some("hello"));
    }

    #[test]
    fn accepts_include_hook_events_for_compatibility() {
        let args = parse(&["--include-hook-events", "hello"]);

        assert_eq!(args.prompt.as_deref(), Some("hello"));
    }

    #[test]
    fn uses_only_first_positional_as_prompt() {
        let args = parse(&["-p", "say", "hello", "world"]);

        assert_eq!(args.prompt.as_deref(), Some("say"));
    }

    #[test]
    fn parses_croxy_flags_after_prompt() {
        let args = parse(&["-p", "hi", "--verbose", "--output-format", "json"]);

        assert_eq!(args.prompt.as_deref(), Some("hi"));
        assert!(args.verbose);
        assert_eq!(args.output_format, OutputFormat::Json);
    }

    #[test]
    fn reports_labeled_missing_claude_values() {
        let err = parse_args(["--model".to_string()]).unwrap_err();
        assert_eq!(
            err.to_string(),
            "error: option '--model <model>' argument missing"
        );

        let err = parse_args(["--allowed-tools".to_string()]).unwrap_err();
        assert_eq!(
            err.to_string(),
            "error: option '--allowedTools, --allowed-tools <tools...>' argument missing"
        );
    }
}
