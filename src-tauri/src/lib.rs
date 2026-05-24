mod graph;
mod pty;
mod review;
mod templates;
mod workspace;

use graph::{engine::execute_plan_background, types::ExecutionPlan};
use pty::{
    manager::{PtyManager, PtyTask},
    providers::{
        find_provider, load_provider_configs_with_override, providers_config_path, ProviderConfig,
    },
};
use review::{HumanReviewDecision, HumanReviewRegistry};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use templates::{
    delete_template, list_templates, load_template, save_template, TemplatePayload,
    TemplatesResponse,
};
use workspace::{
    load_project_graph, load_workspace, normalize_project_root as canonicalize_project_root,
    project_graph_path, save_project_graph, save_workspace, workspace_path,
};

#[derive(Clone, Default)]
struct LoomState {
    pty_manager: PtyManager,
    review_registry: HumanReviewRegistry,
}

#[derive(Debug, Clone, Serialize)]
struct ProvidersResponse {
    providers: Vec<ProviderConfig>,
    config_path: String,
}

#[derive(Debug, Clone, Deserialize)]
struct ListProvidersRequest {
    override_path: Option<String>,
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

#[derive(Debug, Clone, Deserialize)]
struct NormalizeProjectRootRequest {
    root: String,
}

#[derive(Debug, Clone, Serialize)]
struct NormalizeProjectRootResponse {
    root: String,
}

#[derive(Debug, Clone, Deserialize)]
struct ProjectGraphSaveRequest {
    root: String,
    payload: String,
}

#[derive(Debug, Clone, Deserialize)]
struct ProjectGraphLoadRequest {
    root: String,
}

#[derive(Debug, Clone, Serialize)]
struct ProjectGraphLoadResponse {
    path: String,
    payload: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct NodeApproveRequest {
    node_id: String,
    note: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct NodeRejectRequest {
    node_id: String,
    reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct TemplateSaveRequest {
    name: String,
    display_name: String,
    description: Option<String>,
    payload: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
struct TemplateSaveResponse {
    name: String,
    path: String,
}

#[derive(Debug, Clone, Deserialize)]
struct TemplateRequest {
    name: String,
}

#[derive(Debug, Clone, Serialize)]
struct TemplateLoadResponse {
    name: String,
    payload: String,
}

#[tauri::command]
fn list_providers(request: Option<ListProvidersRequest>) -> Result<ProvidersResponse, String> {
    let override_path = request.and_then(|request| request.override_path);
    Ok(ProvidersResponse {
        providers: load_provider_configs_with_override(override_path.as_deref())?,
        config_path: override_path.unwrap_or_else(|| providers_config_path().display().to_string()),
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
    execute_plan_background(
        app,
        state.pty_manager.clone(),
        state.review_registry.clone(),
        run_id.clone(),
        request.plan,
    );

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
fn node_approve(
    state: tauri::State<'_, LoomState>,
    request: NodeApproveRequest,
) -> Result<(), String> {
    state.review_registry.resolve(
        &request.node_id,
        HumanReviewDecision::Approve { note: request.note },
    )
}

#[tauri::command]
fn node_reject(
    state: tauri::State<'_, LoomState>,
    request: NodeRejectRequest,
) -> Result<(), String> {
    state.review_registry.resolve(
        &request.node_id,
        HumanReviewDecision::Reject {
            reason: request.reason.unwrap_or_else(|| "rejected".to_string()),
        },
    )
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

#[tauri::command]
fn normalize_project_root(
    request: NormalizeProjectRootRequest,
) -> Result<NormalizeProjectRootResponse, String> {
    let root = canonicalize_project_root(&request.root)?;
    Ok(NormalizeProjectRootResponse {
        root: root.display().to_string(),
    })
}

#[tauri::command]
fn project_graph_save(request: ProjectGraphSaveRequest) -> Result<String, String> {
    save_project_graph(&request.root, &request.payload).map(|path| path.display().to_string())
}

#[tauri::command]
fn project_graph_load(
    request: ProjectGraphLoadRequest,
) -> Result<ProjectGraphLoadResponse, String> {
    let root = canonicalize_project_root(&request.root)?;
    let payload = load_project_graph(&request.root)?;
    Ok(ProjectGraphLoadResponse {
        path: project_graph_path(&root).display().to_string(),
        payload,
    })
}

#[tauri::command]
fn list_templates_command() -> Result<TemplatesResponse, String> {
    list_templates()
}

#[tauri::command]
fn load_template_command(request: TemplateRequest) -> Result<TemplateLoadResponse, String> {
    let payload = load_template(&request.name)?;
    Ok(TemplateLoadResponse {
        name: request.name,
        payload,
    })
}

#[tauri::command]
fn save_template_command(request: TemplateSaveRequest) -> Result<TemplateSaveResponse, String> {
    let payload = TemplatePayload {
        display_name: request.display_name,
        description: request.description.unwrap_or_default(),
        payload: request.payload,
    };
    let path = save_template(&request.name, payload)?;
    Ok(TemplateSaveResponse {
        name: request.name,
        path: path.display().to_string(),
    })
}

#[tauri::command]
fn delete_template_command(request: TemplateRequest) -> Result<(), String> {
    delete_template(&request.name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(LoomState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_providers,
            execute_single,
            graph_execute,
            node_write,
            node_resize,
            node_kill,
            node_approve,
            node_reject,
            workspace_save,
            workspace_load,
            normalize_project_root,
            project_graph_save,
            project_graph_load,
            list_templates_command,
            load_template_command,
            save_template_command,
            delete_template_command
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
