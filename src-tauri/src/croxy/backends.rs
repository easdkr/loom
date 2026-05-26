use serde_json::Value;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

pub const STARTUP_BUFFER_CAP: usize = 10_000;
const DEFAULT_UPSTREAM: &str = "https://api.anthropic.com";
const DEFAULT_UPSTREAM_TIMEOUT: Duration = Duration::from_secs(120);
static NEXT_PROXY_REQUEST_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, PartialEq)]
pub enum Observation {
    Sse(SseEvent),
    RateLimit {
        status_code: u16,
        retry_after: Option<String>,
    },
    ApiRetry {
        status_code: u16,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BackendCapabilities {
    pub emits_assistant_messages: bool,
    pub emits_results: bool,
    pub emits_post_turn_summary: bool,
    pub updates_output_state: bool,
    pub streams_tokens: bool,
}

impl BackendCapabilities {
    pub const PROXY: Self = Self {
        emits_assistant_messages: false,
        emits_results: false,
        emits_post_turn_summary: false,
        updates_output_state: true,
        streams_tokens: true,
    };
}

#[derive(Debug, Clone, PartialEq)]
pub struct SseEvent {
    pub event: Option<String>,
    pub data: String,
    pub parsed: Option<Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExtractedSseEvents {
    pub complete: Vec<SseEvent>,
    pub remainder: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProxyRequestInfo {
    pub request_id: String,
    pub observe: bool,
}

#[derive(Debug, Clone)]
pub struct ProxyOptions {
    pub upstream_base_url: String,
    pub upstream_timeout: Duration,
}

impl Default for ProxyOptions {
    fn default() -> Self {
        Self {
            upstream_base_url: DEFAULT_UPSTREAM.to_string(),
            upstream_timeout: DEFAULT_UPSTREAM_TIMEOUT,
        }
    }
}

pub type SseEventCallback = Arc<dyn Fn(SseEvent, String, ProxyRequestInfo) + Send + Sync>;
pub type ObservationCallback = Arc<dyn Fn(Observation) + Send + Sync>;
pub type ProxyErrorCallback = Arc<dyn Fn(String) + Send + Sync>;
pub type RequestStartCallback = Arc<dyn Fn(String, String) + Send + Sync>;
pub type RequestEndCallback = Arc<dyn Fn(String, String, u16) + Send + Sync>;
pub type RequestBodyCallback = Arc<dyn Fn(Value, String, ProxyRequestInfo) + Send + Sync>;

#[derive(Clone, Default)]
pub struct ProxyCallbacks {
    pub on_sse_event: Option<SseEventCallback>,
    pub on_observation: Option<ObservationCallback>,
    pub on_proxy_error: Option<ProxyErrorCallback>,
    pub on_request_start: Option<RequestStartCallback>,
    pub on_request_end: Option<RequestEndCallback>,
    pub on_request_body: Option<RequestBodyCallback>,
}

pub struct RunningProxy {
    port: u16,
    shutdown: Option<oneshot::Sender<()>>,
    join: JoinHandle<()>,
}

impl RunningProxy {
    pub fn port(&self) -> u16 {
        self.port
    }

    pub async fn stop(mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        let _ = self.join.await;
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct HttpRequest {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

pub trait ObservationBackend {
    fn claude_env(&self) -> HashMap<String, String>;
    fn capabilities(&self) -> BackendCapabilities;
}

type ObservationSubscriber = Box<dyn FnMut(Observation)>;

#[derive(Default)]
pub struct ProxyBackend {
    port: Option<u16>,
    subscriber: Option<ObservationSubscriber>,
    buffer: Vec<Observation>,
    stopped: bool,
}

impl ProxyBackend {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_port(port: u16) -> Self {
        Self {
            port: Some(port),
            ..Self::default()
        }
    }

    pub fn set_port(&mut self, port: u16) {
        self.port = Some(port);
        self.stopped = false;
    }

    pub fn clear_port(&mut self) {
        self.port = None;
    }

    pub fn is_stopped(&self) -> bool {
        self.stopped
    }

    pub fn stop(&mut self) {
        self.port = None;
        self.stopped = true;
    }

    pub fn emit(&mut self, observation: Observation) -> anyhow::Result<()> {
        if let Some(subscriber) = self.subscriber.as_mut() {
            subscriber(observation);
            return Ok(());
        }
        if self.buffer.len() >= STARTUP_BUFFER_CAP {
            anyhow::bail!("ProxyBackend startup observation buffer exceeded {STARTUP_BUFFER_CAP}");
        }
        self.buffer.push(observation);
        Ok(())
    }

    pub fn on_observation(
        &mut self,
        mut subscriber: impl FnMut(Observation) + 'static,
    ) -> anyhow::Result<()> {
        if self.subscriber.is_some() {
            anyhow::bail!("ProxyBackend only supports one observation subscriber");
        }
        for observation in self.buffer.drain(..) {
            subscriber(observation);
        }
        self.subscriber = Some(Box::new(subscriber));
        Ok(())
    }

    pub fn buffered_len(&self) -> usize {
        self.buffer.len()
    }

    pub fn observed_events(&mut self) -> Rc<RefCell<Vec<Observation>>> {
        let events = Rc::new(RefCell::new(Vec::new()));
        let sink = Rc::clone(&events);
        self.on_observation(move |observation| {
            sink.borrow_mut().push(observation);
        })
        .expect("test observation subscriber should install");
        events
    }
}

impl ObservationBackend for ProxyBackend {
    fn claude_env(&self) -> HashMap<String, String> {
        let mut env = HashMap::new();
        if let Some(port) = self.port {
            env.insert(
                "ANTHROPIC_BASE_URL".to_string(),
                format!("http://127.0.0.1:{port}"),
            );
        }
        env
    }

    fn capabilities(&self) -> BackendCapabilities {
        BackendCapabilities::PROXY
    }
}

pub fn extract_sse_events(buffer: &str) -> ExtractedSseEvents {
    let mut blocks: Vec<&str> = buffer.split("\n\n").collect();
    let remainder = blocks.pop().unwrap_or_default().to_string();
    let mut complete = Vec::new();

    for block in blocks {
        if block.trim().is_empty() {
            continue;
        }

        let mut event = None;
        let mut data_lines = Vec::new();
        for line in block.lines() {
            if let Some(value) = line.strip_prefix("event: ") {
                event = Some(value.trim().to_string());
            } else if let Some(value) = line.strip_prefix("data: ") {
                data_lines.push(value.to_string());
            } else if let Some(value) = line.strip_prefix("data:") {
                data_lines.push(value.to_string());
            }
        }

        if data_lines.is_empty() {
            continue;
        }

        let data = data_lines.join("\n");
        let parsed = serde_json::from_str(&data).ok();
        complete.push(SseEvent {
            event,
            data,
            parsed,
        });
    }

    ExtractedSseEvents {
        complete,
        remainder,
    }
}

pub async fn start_proxy(
    callbacks: ProxyCallbacks,
    options: ProxyOptions,
) -> anyhow::Result<RunningProxy> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let (shutdown_tx, mut shutdown_rx) = oneshot::channel();
    let client = reqwest::Client::builder()
        .timeout(options.upstream_timeout)
        .build()?;
    let callbacks = Arc::new(callbacks);
    let upstream_base_url = Arc::new(options.upstream_base_url);

    let join = tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;
                _ = &mut shutdown_rx => break,
                accepted = listener.accept() => {
                    let Ok((stream, _addr)) = accepted else {
                        break;
                    };
                    let client = client.clone();
                    let callbacks = Arc::clone(&callbacks);
                    let upstream_base_url = Arc::clone(&upstream_base_url);
                    tokio::spawn(async move {
                        if let Err(err) = handle_proxy_client(stream, client, upstream_base_url, callbacks).await {
                            tracing::debug!(error = %err, "proxy client failed");
                        }
                    });
                }
            }
        }
    });

    Ok(RunningProxy {
        port,
        shutdown: Some(shutdown_tx),
        join,
    })
}

async fn handle_proxy_client(
    mut stream: TcpStream,
    client: reqwest::Client,
    upstream_base_url: Arc<String>,
    callbacks: Arc<ProxyCallbacks>,
) -> anyhow::Result<()> {
    let request = read_http_request(&mut stream).await?;
    let request_id = NEXT_PROXY_REQUEST_ID.fetch_add(1, Ordering::Relaxed) + 1;
    let request_id = request_id.to_string();
    if let Some(callback) = &callbacks.on_request_start {
        callback(request.method.clone(), request.path.clone());
    }

    let mut request_info = ProxyRequestInfo {
        request_id,
        observe: request.path.starts_with("/v1/messages"),
    };
    if request_info.observe
        && let Ok(body) = serde_json::from_slice::<Value>(&request.body)
    {
        request_info.observe = should_observe_messages_request(&body);
        if let Some(callback) = &callbacks.on_request_body {
            callback(body, request.path.clone(), request_info.clone());
        }
    }

    let response = forward_request(&client, &upstream_base_url, &request).await;
    match response {
        Ok(response) => {
            write_proxy_response(stream, response, request, request_info, callbacks).await?;
        }
        Err(err) => {
            if let Some(callback) = &callbacks.on_proxy_error {
                callback(err.to_string());
            }
            let body = serde_json::json!({
                "error": {
                    "type": "proxy_error",
                    "message": err.to_string()
                }
            })
            .to_string();
            write_fixed_response(
                &mut stream,
                502,
                "Bad Gateway",
                &[("Content-Type", "application/json")],
                body.as_bytes(),
            )
            .await?;
        }
    }
    Ok(())
}

async fn forward_request(
    client: &reqwest::Client,
    upstream_base_url: &str,
    request: &HttpRequest,
) -> anyhow::Result<reqwest::Response> {
    let method = reqwest::Method::from_bytes(request.method.as_bytes())?;
    let url = format!(
        "{}{}",
        upstream_base_url.trim_end_matches('/'),
        request.path.as_str()
    );
    let mut builder = client.request(method, url);
    for (key, value) in &request.headers {
        let key_lower = key.to_ascii_lowercase();
        if matches!(
            key_lower.as_str(),
            "host" | "connection" | "accept-encoding" | "content-length"
        ) {
            continue;
        }
        builder = builder.header(key, value);
    }
    Ok(builder.body(request.body.clone()).send().await?)
}

async fn write_proxy_response(
    mut stream: TcpStream,
    mut response: reqwest::Response,
    request: HttpRequest,
    request_info: ProxyRequestInfo,
    callbacks: Arc<ProxyCallbacks>,
) -> anyhow::Result<()> {
    let status = response.status();
    let status_code = status.as_u16();
    if let Some(callback) = &callbacks.on_request_end {
        callback(request.method.clone(), request.path.clone(), status_code);
    }
    if status_code == 429 || status_code == 529 {
        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        if let Some(callback) = &callbacks.on_observation {
            callback(Observation::ApiRetry { status_code });
            callback(Observation::RateLimit {
                status_code,
                retry_after,
            });
        }
    }

    let is_messages = request.path.starts_with("/v1/messages");
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let is_sse = content_type.contains("text/event-stream");
    if is_messages
        && status_code == 200
        && !is_sse
        && let Some(callback) = &callbacks.on_proxy_error
    {
        callback(format!("Expected SSE but got content-type: {content_type}"));
    }

    write_chunked_response_head(
        &mut stream,
        status_code,
        status.canonical_reason().unwrap_or(""),
    )
    .await?;
    let mut sse_buffer = String::new();
    while let Some(chunk) = response.chunk().await? {
        if is_messages && is_sse {
            sse_buffer.push_str(&String::from_utf8_lossy(&chunk));
            let extracted = extract_sse_events(&sse_buffer);
            sse_buffer = extracted.remainder;
            for event in extracted.complete {
                if let Some(callback) = &callbacks.on_sse_event {
                    callback(event.clone(), request.path.clone(), request_info.clone());
                }
                if request_info.observe
                    && let Some(callback) = &callbacks.on_observation
                {
                    callback(Observation::Sse(event));
                }
            }
        }
        write_chunk(&mut stream, &chunk).await?;
    }
    if is_messages && is_sse && !sse_buffer.trim().is_empty() {
        let extracted = extract_sse_events(&(sse_buffer + "\n\n"));
        for event in extracted.complete {
            if let Some(callback) = &callbacks.on_sse_event {
                callback(event.clone(), request.path.clone(), request_info.clone());
            }
            if request_info.observe
                && let Some(callback) = &callbacks.on_observation
            {
                callback(Observation::Sse(event));
            }
        }
    }
    stream.write_all(b"0\r\n\r\n").await?;
    Ok(())
}

async fn read_http_request(stream: &mut TcpStream) -> anyhow::Result<HttpRequest> {
    let mut buffer = Vec::new();
    let header_end = loop {
        let mut chunk = [0_u8; 4096];
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            anyhow::bail!("client closed before request headers");
        }
        buffer.extend_from_slice(&chunk[..read]);
        if let Some(pos) = find_header_end(&buffer) {
            break pos;
        }
        if buffer.len() > 1024 * 1024 {
            anyhow::bail!("request headers exceeded 1MiB");
        }
    };

    let headers_bytes = &buffer[..header_end];
    let headers_text = std::str::from_utf8(headers_bytes)?;
    let mut lines = headers_text.split("\r\n");
    let request_line = lines.next().unwrap_or_default();
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or_default().to_string();
    let path = request_parts.next().unwrap_or("/").to_string();
    let headers: Vec<(String, String)> = lines
        .filter_map(|line| {
            let (key, value) = line.split_once(':')?;
            Some((key.trim().to_string(), value.trim().to_string()))
        })
        .collect();
    let content_length = headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.parse::<usize>().ok())
        .unwrap_or_default();
    let body_start = header_end + 4;
    let mut body = buffer.get(body_start..).unwrap_or_default().to_vec();
    while body.len() < content_length {
        let mut chunk = vec![0_u8; content_length - body.len()];
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    body.truncate(content_length);

    Ok(HttpRequest {
        method,
        path,
        headers,
        body,
    })
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n")
}

async fn write_chunked_response_head(
    stream: &mut TcpStream,
    status_code: u16,
    reason: &str,
) -> anyhow::Result<()> {
    stream
        .write_all(
            format!(
                "HTTP/1.1 {status_code} {reason}\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
            )
            .as_bytes(),
        )
        .await?;
    Ok(())
}

async fn write_chunk(stream: &mut TcpStream, chunk: &[u8]) -> anyhow::Result<()> {
    stream
        .write_all(format!("{:x}\r\n", chunk.len()).as_bytes())
        .await?;
    stream.write_all(chunk).await?;
    stream.write_all(b"\r\n").await?;
    Ok(())
}

async fn write_fixed_response(
    stream: &mut TcpStream,
    status_code: u16,
    reason: &str,
    headers: &[(&str, &str)],
    body: &[u8],
) -> anyhow::Result<()> {
    stream
        .write_all(format!("HTTP/1.1 {status_code} {reason}\r\n").as_bytes())
        .await?;
    for (key, value) in headers {
        stream
            .write_all(format!("{key}: {value}\r\n").as_bytes())
            .await?;
    }
    stream
        .write_all(
            format!(
                "Content-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .as_bytes(),
        )
        .await?;
    stream.write_all(body).await?;
    Ok(())
}

pub fn should_observe_messages_request(body: &Value) -> bool {
    !is_claude_session_title_request(body)
}

fn is_claude_session_title_request(body: &Value) -> bool {
    const MARKERS: [&str; 2] = [
        "Generate a concise, sentence-case title",
        "Return JSON with a single \"title\" field",
    ];

    has_any_text_marker(body.get("system"), &MARKERS) && has_single_title_json_schema(Some(body))
}

fn has_any_text_marker(value: Option<&Value>, markers: &[&str]) -> bool {
    let Some(value) = value else {
        return false;
    };
    match value {
        Value::String(text) => markers.iter().any(|marker| text.contains(marker)),
        Value::Array(items) => items
            .iter()
            .any(|item| has_any_text_marker(Some(item), markers)),
        Value::Object(object) => object
            .values()
            .any(|item| has_any_text_marker(Some(item), markers)),
        _ => false,
    }
}

fn has_single_title_json_schema(value: Option<&Value>) -> bool {
    let Some(value) = value else {
        return false;
    };
    match value {
        Value::Array(items) => items
            .iter()
            .any(|item| has_single_title_json_schema(Some(item))),
        Value::Object(object) => {
            object.get("type").and_then(Value::as_str) == Some("json_schema")
                && schema_only_allows_title(object.get("schema"))
                || object
                    .values()
                    .any(|item| has_single_title_json_schema(Some(item)))
        }
        _ => false,
    }
}

fn schema_only_allows_title(schema: Option<&Value>) -> bool {
    let Some(Value::Object(schema)) = schema else {
        return false;
    };
    let Some(Value::Object(properties)) = schema.get("properties") else {
        return false;
    };
    if properties.len() != 1 || !properties.contains_key("title") {
        return false;
    }
    match schema.get("required") {
        Some(Value::Array(required)) => {
            required.len() == 1 && required.first().and_then(Value::as_str) == Some("title")
        }
        Some(_) => false,
        None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    #[test]
    fn extracts_single_complete_event() {
        let result =
            extract_sse_events("event: message_start\ndata: {\"type\":\"message_start\"}\n\n");

        assert_eq!(result.complete.len(), 1);
        assert_eq!(result.complete[0].event.as_deref(), Some("message_start"));
        assert_eq!(
            result.complete[0].parsed,
            Some(json!({"type": "message_start"}))
        );
        assert_eq!(result.remainder, "");
    }

    #[test]
    fn keeps_incomplete_event_as_remainder() {
        let result = extract_sse_events("event: message_start\ndata: {\"type\":\"mes");

        assert!(result.complete.is_empty());
        assert_eq!(
            result.remainder,
            "event: message_start\ndata: {\"type\":\"mes"
        );
    }

    #[test]
    fn extracts_multiline_data_without_event_type() {
        let result = extract_sse_events("data: {\"line\":\ndata: \"value\"}\n\n");

        assert_eq!(result.complete.len(), 1);
        assert_eq!(result.complete[0].event, None);
        assert_eq!(result.complete[0].data, "{\"line\":\n\"value\"}");
        assert_eq!(result.complete[0].parsed, Some(json!({"line": "value"})));
    }

    #[test]
    fn keeps_non_json_data_unparsed() {
        let result = extract_sse_events("event: ping\ndata: not json\n\n");

        assert_eq!(result.complete.len(), 1);
        assert_eq!(result.complete[0].data, "not json");
        assert_eq!(result.complete[0].parsed, None);
    }

    #[test]
    fn filters_claude_session_title_generation_requests() {
        assert!(!should_observe_messages_request(&json!({
            "model": "claude-haiku",
            "system": [{
                "type": "text",
                "text": "Generate a concise, sentence-case title (3-7 words).\n\nReturn JSON with a single \"title\" field."
            }],
            "messages": [{"role": "user", "content": "answer in one word: ok"}],
            "output_config": {
                "format": {
                    "type": "json_schema",
                    "schema": {
                        "type": "object",
                        "properties": {"title": {"type": "string"}},
                        "required": ["title"],
                        "additionalProperties": false
                    }
                }
            }
        })));
    }

    #[test]
    fn observes_normal_message_requests() {
        assert!(should_observe_messages_request(&json!({
            "model": "claude-opus",
            "system": [{"type": "text", "text": "You are Claude Code."}],
            "messages": [{"role": "user", "content": "hello"}]
        })));
    }

    #[test]
    fn observes_user_json_schema_requests_that_happen_to_produce_a_title() {
        assert!(should_observe_messages_request(&json!({
            "model": "claude-opus",
            "system": [{"type": "text", "text": "Respond according to the user's schema."}],
            "messages": [{"role": "user", "content": "Return a title for this article."}],
            "output_config": {
                "format": {
                    "type": "json_schema",
                    "schema": {
                        "type": "object",
                        "properties": {"title": {"type": "string"}},
                        "required": ["title"]
                    }
                }
            }
        })));
    }

    #[test]
    fn proxy_backend_reports_claude_env_after_port_is_set() {
        let backend = ProxyBackend::with_port(1234);

        assert_eq!(
            backend
                .claude_env()
                .get("ANTHROPIC_BASE_URL")
                .map(String::as_str),
            Some("http://127.0.0.1:1234")
        );
        assert_eq!(backend.capabilities(), BackendCapabilities::PROXY);
    }

    #[test]
    fn proxy_backend_buffers_observations_until_subscribed() {
        let mut backend = ProxyBackend::new();
        let event = SseEvent {
            event: Some("message_start".to_string()),
            data: "{}".to_string(),
            parsed: Some(json!({})),
        };

        backend.emit(Observation::Sse(event.clone())).unwrap();
        assert_eq!(backend.buffered_len(), 1);

        let observed = backend.observed_events();
        assert_eq!(backend.buffered_len(), 0);
        assert_eq!(observed.borrow().as_slice(), &[Observation::Sse(event)]);

        backend
            .emit(Observation::ApiRetry { status_code: 429 })
            .unwrap();
        assert_eq!(
            observed.borrow().as_slice(),
            &[
                Observation::Sse(SseEvent {
                    event: Some("message_start".to_string()),
                    data: "{}".to_string(),
                    parsed: Some(json!({})),
                }),
                Observation::ApiRetry { status_code: 429 }
            ]
        );
    }

    #[test]
    fn proxy_backend_allows_only_one_subscriber() {
        let mut backend = ProxyBackend::new();

        backend.on_observation(|_| {}).unwrap();
        let err = backend.on_observation(|_| {}).unwrap_err();

        assert!(err.to_string().contains("one observation subscriber"));
    }

    #[tokio::test]
    async fn local_proxy_forwards_messages_and_emits_sse_observations() {
        let sse_body = concat!(
            "event: message_start\n",
            "data: {\"type\":\"message_start\",\"message\":{\"id\":\"m1\"}}\n\n",
            "event: message_stop\n",
            "data: {\"type\":\"message_stop\"}\n\n"
        );
        let upstream =
            spawn_test_upstream(200, "text/event-stream", sse_body.as_bytes().to_vec()).await;
        let observations = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&observations);
        let proxy = start_proxy(
            ProxyCallbacks {
                on_observation: Some(Arc::new(move |observation| {
                    captured.lock().unwrap().push(observation);
                })),
                ..ProxyCallbacks::default()
            },
            ProxyOptions {
                upstream_base_url: upstream.base_url,
                upstream_timeout: Duration::from_secs(5),
            },
        )
        .await
        .unwrap();

        let response = send_proxy_request(
            proxy.port(),
            "/v1/messages",
            json!({
                "model": "claude-opus",
                "system": [{"type": "text", "text": "You are Claude Code."}],
                "messages": [{"role": "user", "content": "hello"}]
            })
            .to_string()
            .as_bytes(),
        )
        .await;
        proxy.stop().await;

        assert!(response.contains("HTTP/1.1 200 OK"));
        assert!(response.contains("message_start"));
        let observations = observations.lock().unwrap();
        assert_eq!(observations.len(), 2);
        assert!(
            matches!(&observations[0], Observation::Sse(event) if event.event.as_deref() == Some("message_start"))
        );
        assert!(
            matches!(&observations[1], Observation::Sse(event) if event.event.as_deref() == Some("message_stop"))
        );
    }

    #[tokio::test]
    async fn local_proxy_filters_title_generation_sse_observations() {
        let sse_body = "event: message_start\ndata: {\"type\":\"message_start\"}\n\n";
        let upstream =
            spawn_test_upstream(200, "text/event-stream", sse_body.as_bytes().to_vec()).await;
        let observations = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&observations);
        let proxy = start_proxy(
            ProxyCallbacks {
                on_observation: Some(Arc::new(move |observation| {
                    captured.lock().unwrap().push(observation);
                })),
                ..ProxyCallbacks::default()
            },
            ProxyOptions {
                upstream_base_url: upstream.base_url,
                upstream_timeout: Duration::from_secs(5),
            },
        )
        .await
        .unwrap();

        let response = send_proxy_request(
            proxy.port(),
            "/v1/messages",
            json!({
                "model": "claude-haiku",
                "system": [{
                    "type": "text",
                    "text": "Generate a concise, sentence-case title (3-7 words).\n\nReturn JSON with a single \"title\" field."
                }],
                "messages": [{"role": "user", "content": "hello"}],
                "output_config": {
                    "format": {
                        "type": "json_schema",
                        "schema": {
                            "type": "object",
                            "properties": {"title": {"type": "string"}},
                            "required": ["title"]
                        }
                    }
                }
            })
            .to_string()
            .as_bytes(),
        )
        .await;
        proxy.stop().await;

        assert!(response.contains("HTTP/1.1 200 OK"));
        assert!(observations.lock().unwrap().is_empty());
    }

    struct TestUpstream {
        base_url: String,
    }

    async fn spawn_test_upstream(
        status: u16,
        content_type: &'static str,
        body: Vec<u8>,
    ) -> TestUpstream {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            loop {
                let mut chunk = [0_u8; 1024];
                let read = stream.read(&mut chunk).await.unwrap();
                if read == 0 {
                    return;
                }
                request.extend_from_slice(&chunk[..read]);
                if find_header_end(&request).is_some() {
                    break;
                }
            }
            let reason = if status == 200 { "OK" } else { "Error" };
            let response = format!(
                "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
            stream.write_all(&body).await.unwrap();
        });
        TestUpstream {
            base_url: format!("http://{addr}"),
        }
    }

    async fn send_proxy_request(port: u16, path: &str, body: &[u8]) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let request = format!(
            "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        stream.write_all(body).await.unwrap();

        let mut response = Vec::new();
        stream.read_to_end(&mut response).await.unwrap();
        String::from_utf8(response).unwrap()
    }
}
