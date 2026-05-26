use crate::croxy::backends::SseEvent;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type")]
pub enum ContentBlock {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "thinking")]
    Thinking { thinking: String },
    #[serde(rename = "tool_use")]
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    #[serde(rename = "tool_result")]
    ToolResult { tool_use_id: String, content: Value },
}

#[derive(Debug, Default, Clone, PartialEq, Serialize)]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AssembledMessage {
    pub id: String,
    pub role: &'static str,
    pub model: String,
    pub content: Vec<ContentBlock>,
    pub stop_reason: Option<String>,
    pub usage: TokenUsage,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
pub struct ContextUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub cache_creation_input_tokens: u64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolUse {
    pub id: String,
    pub name: String,
    pub input: Value,
}

#[derive(Debug, Default)]
pub struct MessageAssembler {
    current: Option<MessageState>,
    last_tool_use: Option<ToolUse>,
    context_usage: ContextUsage,
}

#[derive(Debug, Clone, PartialEq)]
struct MessageState {
    id: String,
    model: String,
    content: Vec<ContentBlock>,
    stop_reason: Option<String>,
    usage: TokenUsage,
}

impl MessageAssembler {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn last_tool_use(&self) -> Option<&ToolUse> {
        self.last_tool_use.as_ref()
    }

    pub fn context_usage(&self) -> &ContextUsage {
        &self.context_usage
    }

    pub fn reset(&mut self) {
        self.current = None;
        self.last_tool_use = None;
        self.context_usage = ContextUsage::default();
    }

    pub fn process_sse(&mut self, event: &SseEvent) -> Vec<AssembledMessage> {
        let Some(parsed) = event.parsed.as_ref().and_then(Value::as_object) else {
            return Vec::new();
        };
        let Some(event_type) = parsed.get("type").and_then(Value::as_str) else {
            return Vec::new();
        };

        match event_type {
            "message_start" => {
                let message = parsed.get("message").and_then(Value::as_object);
                let usage = message
                    .and_then(|message| message.get("usage"))
                    .and_then(Value::as_object);
                let input_tokens = number_field(usage, "input_tokens");
                let output_tokens = number_field(usage, "output_tokens");
                self.context_usage.input_tokens =
                    keep_latest_non_zero(input_tokens, self.context_usage.input_tokens);
                self.context_usage.cache_read_input_tokens = keep_latest_non_zero(
                    number_field(usage, "cache_read_input_tokens"),
                    self.context_usage.cache_read_input_tokens,
                );
                self.context_usage.cache_creation_input_tokens = keep_latest_non_zero(
                    number_field(usage, "cache_creation_input_tokens"),
                    self.context_usage.cache_creation_input_tokens,
                );
                self.current = Some(MessageState {
                    id: string_field(message, "id"),
                    model: string_field(message, "model"),
                    content: Vec::new(),
                    stop_reason: None,
                    usage: TokenUsage {
                        input_tokens,
                        output_tokens,
                    },
                });
                Vec::new()
            }
            "content_block_start" => {
                let Some(current) = self.current.as_mut() else {
                    return Vec::new();
                };
                let block = parsed.get("content_block").and_then(Value::as_object);
                match block
                    .and_then(|block| block.get("type"))
                    .and_then(Value::as_str)
                {
                    Some("text") => current.content.push(ContentBlock::Text {
                        text: string_field(block, "text"),
                    }),
                    Some("thinking") => current.content.push(ContentBlock::Thinking {
                        thinking: string_field(block, "thinking"),
                    }),
                    Some("tool_use") => current.content.push(ContentBlock::ToolUse {
                        id: string_field(block, "id"),
                        name: string_field(block, "name"),
                        input: Value::Object(serde_json::Map::new()),
                    }),
                    _ => {}
                }
                Vec::new()
            }
            "content_block_delta" => {
                let Some(current) = self.current.as_mut() else {
                    return Vec::new();
                };
                let Some(block) = current.content.last_mut() else {
                    return Vec::new();
                };
                let delta = parsed.get("delta").and_then(Value::as_object);
                match (
                    delta
                        .and_then(|delta| delta.get("type"))
                        .and_then(Value::as_str),
                    block,
                ) {
                    (Some("text_delta"), ContentBlock::Text { text }) => {
                        text.push_str(&string_field(delta, "text"));
                    }
                    (Some("thinking_delta"), ContentBlock::Thinking { thinking }) => {
                        thinking.push_str(&string_field(delta, "thinking"));
                    }
                    (Some("input_json_delta"), ContentBlock::ToolUse { input, .. }) => {
                        let partial = string_field(delta, "partial_json");
                        if let Value::String(existing) = input {
                            existing.push_str(&partial);
                        } else {
                            *input = Value::String(partial);
                        }
                    }
                    _ => {}
                }
                Vec::new()
            }
            "content_block_stop" => {
                let Some(current) = self.current.as_mut() else {
                    return Vec::new();
                };
                let Some(block) = current.content.last_mut() else {
                    return Vec::new();
                };
                if let ContentBlock::ToolUse { id, name, input } = block {
                    if let Value::String(raw) = input {
                        if let Ok(parsed) = serde_json::from_str(raw) {
                            *input = parsed;
                        }
                    }
                    self.last_tool_use = Some(ToolUse {
                        id: id.clone(),
                        name: name.clone(),
                        input: input.clone(),
                    });
                }

                vec![AssembledMessage {
                    id: current.id.clone(),
                    role: "assistant",
                    model: current.model.clone(),
                    content: vec![block.clone()],
                    stop_reason: None,
                    usage: current.usage.clone(),
                }]
            }
            "message_delta" => {
                if let Some(current) = self.current.as_mut() {
                    if let Some(stop_reason) = parsed
                        .get("delta")
                        .and_then(Value::as_object)
                        .and_then(|delta| delta.get("stop_reason"))
                        .and_then(Value::as_str)
                    {
                        current.stop_reason = Some(stop_reason.to_string());
                    }
                    let usage = parsed.get("usage").and_then(Value::as_object);
                    let output_tokens = number_field(usage, "output_tokens");
                    current.usage.output_tokens =
                        keep_latest_non_zero(output_tokens, current.usage.output_tokens);
                    self.context_usage.output_tokens =
                        keep_latest_non_zero(output_tokens, self.context_usage.output_tokens);
                }
                Vec::new()
            }
            "message_stop" => {
                self.current = None;
                Vec::new()
            }
            _ => Vec::new(),
        }
    }
}

fn string_field(object: Option<&serde_json::Map<String, Value>>, field: &str) -> String {
    object
        .and_then(|object| object.get(field))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn number_field(object: Option<&serde_json::Map<String, Value>>, field: &str) -> u64 {
    object
        .and_then(|object| object.get(field))
        .and_then(Value::as_u64)
        .unwrap_or_default()
}

fn keep_latest_non_zero(next: u64, current: u64) -> u64 {
    if next == 0 { current } else { next }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sse(parsed: Value) -> SseEvent {
        SseEvent {
            event: None,
            data: parsed.to_string(),
            parsed: Some(parsed),
        }
    }

    fn collect(events: Vec<SseEvent>) -> Vec<AssembledMessage> {
        let mut assembler = MessageAssembler::new();
        events
            .iter()
            .flat_map(|event| assembler.process_sse(event))
            .collect()
    }

    #[test]
    fn emits_on_content_block_stop_with_single_block() {
        let messages = collect(vec![
            sse(
                json!({"type":"message_start","message":{"id":"msg_01","model":"claude-opus-4-7","content":[],"usage":{"input_tokens":100,"output_tokens":0}}}),
            ),
            sse(
                json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
            ),
            sse(
                json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}),
            ),
            sse(
                json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}),
            ),
            sse(json!({"type":"content_block_stop","index":0})),
            sse(
                json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}),
            ),
            sse(json!({"type":"message_stop"})),
        ]);

        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].id, "msg_01");
        assert_eq!(messages[0].model, "claude-opus-4-7");
        assert_eq!(
            messages[0].content,
            vec![ContentBlock::Text {
                text: "Hello world".to_string()
            }]
        );
        assert_eq!(messages[0].stop_reason, None);
        assert_eq!(messages[0].usage.input_tokens, 100);
    }

    #[test]
    fn emits_per_content_block_for_thinking_and_text() {
        let messages = collect(vec![
            sse(
                json!({"type":"message_start","message":{"id":"msg_02","model":"claude-opus-4-7","content":[],"usage":{"input_tokens":50}}}),
            ),
            sse(
                json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}),
            ),
            sse(
                json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me think..."}}),
            ),
            sse(json!({"type":"content_block_stop","index":0})),
            sse(
                json!({"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}),
            ),
            sse(
                json!({"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Answer"}}),
            ),
            sse(json!({"type":"content_block_stop","index":1})),
        ]);

        assert_eq!(messages.len(), 2);
        assert_eq!(
            messages[0].content,
            vec![ContentBlock::Thinking {
                thinking: "Let me think...".to_string()
            }]
        );
        assert_eq!(
            messages[1].content,
            vec![ContentBlock::Text {
                text: "Answer".to_string()
            }]
        );
    }

    #[test]
    fn assembles_tool_use_with_json_input() {
        let messages = collect(vec![
            sse(
                json!({"type":"message_start","message":{"id":"msg_03","model":"claude-opus-4-7","content":[]}}),
            ),
            sse(
                json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_01","name":"Bash"}}),
            ),
            sse(
                json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"comm"}}),
            ),
            sse(
                json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"and\":\"ls\"}"}}),
            ),
            sse(json!({"type":"content_block_stop","index":0})),
        ]);

        assert_eq!(messages.len(), 1);
        assert_eq!(
            messages[0].content,
            vec![ContentBlock::ToolUse {
                id: "toolu_01".to_string(),
                name: "Bash".to_string(),
                input: json!({"command": "ls"}),
            }]
        );
    }

    #[test]
    fn leaves_malformed_tool_input_as_string() {
        let messages = collect(vec![
            sse(
                json!({"type":"message_start","message":{"id":"msg_04","model":"claude-opus-4-7","content":[]}}),
            ),
            sse(
                json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_02","name":"Read"}}),
            ),
            sse(
                json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{broken"}}),
            ),
            sse(json!({"type":"content_block_stop","index":0})),
        ]);

        assert_eq!(
            messages[0].content,
            vec![ContentBlock::ToolUse {
                id: "toolu_02".to_string(),
                name: "Read".to_string(),
                input: Value::String("{broken".to_string()),
            }]
        );
    }

    #[test]
    fn tracks_last_tool_use() {
        let mut assembler = MessageAssembler::new();
        for event in [
            sse(
                json!({"type":"message_start","message":{"id":"msg_t","model":"claude-opus-4-7","content":[]}}),
            ),
            sse(
                json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_99","name":"Read"}}),
            ),
            sse(
                json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"file_path\":\"/tmp/x\"}"}}),
            ),
            sse(json!({"type":"content_block_stop","index":0})),
        ] {
            assembler.process_sse(&event);
        }

        let tool = assembler
            .last_tool_use()
            .expect("tool_use should be tracked");
        assert_eq!(tool.name, "Read");
        assert_eq!(tool.id, "toolu_99");
        assert_eq!(tool.input, json!({"file_path": "/tmp/x"}));
    }

    #[test]
    fn ignores_events_without_message_start() {
        let messages = collect(vec![
            sse(
                json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"orphan"}}),
            ),
            sse(json!({"type":"message_stop"})),
        ]);

        assert!(messages.is_empty());
    }
}
