use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiErrorInfo {
    pub status: Option<u16>,
    pub message: String,
    pub retry_attempt: Option<u64>,
    pub max_retries: Option<u64>,
    pub retry_in_ms: Option<u64>,
}

pub fn is_transcript_api_error(event: &Value) -> bool {
    event.get("type").and_then(Value::as_str) == Some("system")
        && event.get("subtype").and_then(Value::as_str) == Some("api_error")
}

pub fn is_transcript_api_error_message(event: &Value) -> bool {
    event.get("type").and_then(Value::as_str) == Some("assistant")
        && event.get("isApiErrorMessage").and_then(Value::as_bool) == Some(true)
}

pub fn get_transcript_assistant_text(event: &Value) -> String {
    event
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
        .map(|content| {
            content
                .iter()
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect::<String>()
        })
        .unwrap_or_default()
        .trim()
        .to_string()
}

pub fn get_transcript_api_error_info(event: &Value) -> Option<ApiErrorInfo> {
    if !is_transcript_api_error(event) {
        return None;
    }

    let error = event.get("error")?;
    let nested_error = error.get("error");
    let api_error = nested_error.and_then(|nested| nested.get("error"));
    let message = api_error
        .and_then(|value| value.get("message"))
        .and_then(Value::as_str)
        .or_else(|| {
            nested_error
                .and_then(|value| value.get("message"))
                .and_then(Value::as_str)
        })
        .or_else(|| error.get("message").and_then(Value::as_str))
        .or_else(|| error.get("type").and_then(Value::as_str))
        .unwrap_or("API error")
        .to_string();

    Some(ApiErrorInfo {
        status: error
            .get("status")
            .and_then(Value::as_u64)
            .and_then(|status| u16::try_from(status).ok()),
        message,
        retry_attempt: event.get("retryAttempt").and_then(Value::as_u64),
        max_retries: event.get("maxRetries").and_then(Value::as_u64),
        retry_in_ms: event.get("retryInMs").and_then(Value::as_u64),
    })
}

pub fn format_transcript_api_error(info: &ApiErrorInfo) -> String {
    let status = info
        .status
        .map(|status| format!("{status} "))
        .unwrap_or_default();
    format!("API Error: {status}{}.", info.message)
}

pub fn format_transcript_api_retry(info: &ApiErrorInfo) -> String {
    let base = format_transcript_api_error(info);
    let attempt = match (info.retry_attempt, info.max_retries) {
        (Some(retry_attempt), Some(max_retries)) => {
            format!("attempt {retry_attempt}/{max_retries}")
        }
        _ => String::new(),
    };
    let delay = info
        .retry_in_ms
        .map(|retry_in_ms| format!("retrying in {}s", retry_in_ms.div_ceil(1000)))
        .unwrap_or_default();
    let suffix = [delay, attempt]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(", ");
    if suffix.is_empty() {
        base
    } else {
        format!("{base} {suffix}.")
    }
}

pub fn is_retry_exhausted(info: &ApiErrorInfo) -> bool {
    matches!(
        (info.retry_attempt, info.max_retries),
        (Some(retry_attempt), Some(max_retries)) if retry_attempt >= max_retries
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extracts_nested_api_error_info_and_formats_retry() {
        let event = json!({
            "type": "system",
            "subtype": "api_error",
            "error": {
                "status": 429,
                "error": {
                    "error": { "message": "rate limited" }
                }
            },
            "retryAttempt": 2,
            "maxRetries": 3,
            "retryInMs": 1500
        });

        let info = get_transcript_api_error_info(&event).unwrap();
        assert_eq!(info.status, Some(429));
        assert_eq!(info.message, "rate limited");
        assert_eq!(
            format_transcript_api_retry(&info),
            "API Error: 429 rate limited. retrying in 2s, attempt 2/3."
        );
        assert!(!is_retry_exhausted(&info));
    }

    #[test]
    fn extracts_assistant_api_error_text() {
        let event = json!({
            "type": "assistant",
            "isApiErrorMessage": true,
            "message": {
                "content": [
                    { "type": "text", "text": " failed " },
                    { "type": "text", "text": "again" }
                ]
            }
        });

        assert!(is_transcript_api_error_message(&event));
        assert_eq!(get_transcript_assistant_text(&event), "failed again");
    }
}
