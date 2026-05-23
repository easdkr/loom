mod graph;
mod pty;
mod workspace;

use graph::{engine::execute_plan_background, types::ExecutionPlan};
use pty::{
    manager::{PtyManager, PtyTask},
    providers::{find_provider, load_provider_configs, providers_config_path, ProviderConfig},
};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use workspace::{load_workspace, save_workspace, workspace_path};

#[derive(Clone, Default)]
struct LoomState {
    pty_manager: PtyManager,
}

#[derive(Debug, Clone, Serialize)]
struct ProvidersResponse {
    providers: Vec<ProviderConfig>,
    config_path: String,
}

#[derive(Debug, Clone, Deserialize)]
struct GraphExecuteRequest {
    run_id: Option<String>,
    plan: ExecutionPlan,
}

#[derive(Debug, Clone, Deserialize)]
struct NodeWriteRequest {
    node_id: String,
    input: String,
}

#[derive(Debug, Clone, Deserialize)]
struct NodeKillRequest {
    node_id: String,
}

#[derive(Debug, Clone, Deserialize)]
struct NodeResizeRequest {
    node_id: String,
    cols: u16,
    rows: u16,
}

#[derive(Debug, Clone, Deserialize)]
struct WorkspaceSaveRequest {
    payload: String,
}

#[derive(Debug, Clone, Serialize)]
struct WorkspaceLoadResponse {
    path: String,
    payload: Option<String>,
}

#[tauri::command]
fn list_providers() -> Result<ProvidersResponse, String> {
    Ok(ProvidersResponse {
        providers: load_provider_configs()?,
        config_path: providers_config_path().display().to_string(),
    })
}

#[tauri::command]
fn execute_single(
    app: tauri::AppHandle,
    state: tauri::State<'_, LoomState>,
    request: PtyTask,
) -> Result<String, String> {
    let provider = find_provider(&request.provider)?;
    state.pty_manager.run_background(app, provider, request)
}

#[tauri::command]
fn graph_execute(
    app: tauri::AppHandle,
    state: tauri::State<'_, LoomState>,
    request: GraphExecuteRequest,
) -> Result<String, String> {
    let run_id = request.run_id.unwrap_or_else(generate_run_id);
    execute_plan_background(app, state.pty_manager.clone(), run_id.clone(), request.plan);

    Ok(run_id)
}

#[tauri::command]
fn node_write(state: tauri::State<'_, LoomState>, request: NodeWriteRequest) -> Result<(), String> {
    state.pty_manager.write(&request.node_id, &request.input)
}

#[tauri::command]
fn node_kill(state: tauri::State<'_, LoomState>, request: NodeKillRequest) -> Result<(), String> {
    state.pty_manager.kill(&request.node_id)
}

#[tauri::command]
fn node_resize(
    state: tauri::State<'_, LoomState>,
    request: NodeResizeRequest,
) -> Result<(), String> {
    state
        .pty_manager
        .resize(&request.node_id, request.cols, request.rows)
}

#[tauri::command]
fn workspace_save(request: WorkspaceSaveRequest) -> Result<String, String> {
    save_workspace(&request.payload).map(|path| path.display().to_string())
}

#[tauri::command]
fn workspace_load() -> Result<WorkspaceLoadResponse, String> {
    let payload = load_workspace()?;
    Ok(WorkspaceLoadResponse {
        path: workspace_path().display().to_string(),
        payload,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(LoomState::default())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_providers,
            execute_single,
            graph_execute,
            node_write,
            node_resize,
            node_kill,
            workspace_save,
            workspace_load
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn generate_run_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    format!("run-{millis}")
}
