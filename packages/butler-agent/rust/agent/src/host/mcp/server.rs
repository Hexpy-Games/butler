//! rmcp stdio server for the retained eight-tool MCP surface.

use std::path::PathBuf;

use rmcp::schemars::{self, JsonSchema};
use rmcp::{
    ServerHandler, ServiceExt,
    handler::server::wrapper::Parameters,
    model::{CallToolResult, ContentBlock, Implementation, ServerCapabilities, ServerConfig},
    tool, tool_handler, tool_router,
};
use serde::Deserialize;
use tokio_util::sync::CancellationToken;

use super::{graph, model, restart, skills, status, stdio::NonblockingStdio};
use crate::{ResolvedInstallation, operations};

pub(super) async fn serve(
    installation: ResolvedInstallation,
    data_root: PathBuf,
    name: String,
) -> Result<(), String> {
    let mut shutdown = ShutdownSignals::install().map_err(|error| error.to_string())?;
    let cancellation = CancellationToken::new();
    let transport = NonblockingStdio::new().map_err(|error| error.to_string())?;
    let initialization = McpServer::new(installation, data_root, name)
        .serve_with_ct(transport, cancellation.clone());
    tokio::pin!(initialization);
    let initialized = tokio::select! {
        result = &mut initialization => result,
        _ = shutdown.recv() => {
            cancellation.cancel();
            initialization.await
        }
    };
    let service = match initialized {
        Ok(service) => service,
        Err(rmcp::service::ServerInitializeError::Cancelled) => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    let mut waiter = tokio::spawn(service.waiting());
    tokio::select! {
        result = &mut waiter => flatten_wait(result),
        _ = shutdown.recv() => {
            cancellation.cancel();
            flatten_wait(waiter.await)
        }
    }
}

struct ShutdownSignals {
    terminate: tokio::signal::unix::Signal,
    hangup: tokio::signal::unix::Signal,
    pipe: tokio::signal::unix::Signal,
}

impl ShutdownSignals {
    fn install() -> std::io::Result<Self> {
        use tokio::signal::unix::{SignalKind, signal};
        Ok(Self {
            terminate: signal(SignalKind::terminate())?,
            hangup: signal(SignalKind::hangup())?,
            pipe: signal(SignalKind::pipe())?,
        })
    }

    async fn recv(&mut self) {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = self.terminate.recv() => {},
            _ = self.hangup.recv() => {},
            _ = self.pipe.recv() => {},
        }
    }
}

fn flatten_wait(
    result: Result<
        Result<rmcp::service::QuitReason, tokio::task::JoinError>,
        tokio::task::JoinError,
    >,
) -> Result<(), String> {
    match result {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(error)) | Err(error) => Err(error.to_string()),
    }
}

struct McpServer {
    installation: ResolvedInstallation,
    data_root: PathBuf,
    home: PathBuf,
    name: String,
}

impl McpServer {
    fn new(installation: ResolvedInstallation, data_root: PathBuf, name: String) -> Self {
        let home = std::env::var_os("HOME")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_default();
        Self {
            installation,
            data_root,
            home,
            name,
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
struct EmptyArgs {}

#[derive(Debug, Deserialize, JsonSchema)]
struct GetTaskResultArgs {
    #[schemars(description = "Task ID returned by dispatch_task")]
    task_id: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ListTasksArgs {
    #[schemars(description = "Filter by status")]
    status: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
enum ModelTarget {
    Worker,
    Butler,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
enum ModelAction {
    List,
}

#[derive(Debug, Deserialize, JsonSchema)]
struct ModelSetArgs {
    #[schemars(
        description = "Which model to set: worker (dispatch_task) or butler (main session). Omit to show both."
    )]
    target: Option<ModelTarget>,
    #[schemars(description = "Model alias to set. Omit to get current model(s).")]
    model: Option<String>,
    #[schemars(description = "Set to 'list' to show all available models.")]
    action: Option<ModelAction>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
enum GraphEntityType {
    Project,
    Person,
    Concept,
    Decision,
    Tool,
    Interest,
}

impl GraphEntityType {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::Person => "person",
            Self::Concept => "concept",
            Self::Decision => "decision",
            Self::Tool => "tool",
            Self::Interest => "interest",
        }
    }
}

#[derive(Debug, Deserialize, JsonSchema)]
struct MemoryGraphArgs {
    #[schemars(description = "Entity name or keyword to search")]
    query: String,
    #[serde(rename = "type")]
    #[schemars(description = "Filter by entity type")]
    entity_type: Option<GraphEntityType>,
    #[schemars(
        range(min = 1, max = 4),
        description = "How many relationship hops to traverse (default: 2)"
    )]
    hops: Option<u32>,
    #[schemars(description = "Filter results to a specific project (e.g. 'butler')")]
    project: Option<String>,
}

#[tool_router]
impl McpServer {
    #[tool(
        name = "get_task_result",
        description = "Get the full result of a completed task."
    )]
    async fn get_task_result(
        &self,
        Parameters(args): Parameters<GetTaskResultArgs>,
    ) -> CallToolResult {
        let task = operations::read_mcp_task(&self.data_root, &args.task_id);
        let mut lines = vec![
            format!("Task: {}", task.task_id),
            format!("Status: {}", task.status),
            format!("Project: {}", task.project),
            format!("Request: {}", task.request),
        ];
        if let Some(result) = task.result.filter(|value| !value.is_empty()) {
            lines.push(format!("\nResult:\n{result}"));
        }
        text_result(lines.join("\n"))
    }

    #[tool(
        name = "list_tasks",
        description = "List all tasks, optionally filtered by status (RUNNING, DONE, FAILED, PENDING)."
    )]
    async fn list_tasks(&self, Parameters(args): Parameters<ListTasksArgs>) -> CallToolResult {
        let filter = args.status.as_deref().filter(|value| !value.is_empty());
        let tasks = operations::read_mcp_task_list(&self.data_root, filter);
        if tasks.is_empty() {
            return text_result("No tasks found.".into());
        }
        let lines = tasks
            .iter()
            .map(|task| {
                format!(
                    "{}  {}  {}  {}",
                    task.task_id,
                    pad_end(&task.status, 8),
                    pad_end(&task.project, 15),
                    slice_utf16(&task.request, 60),
                )
            })
            .collect::<Vec<_>>();
        text_result(lines.join("\n"))
    }

    #[tool(
        name = "butler_status",
        description = "Get butler system status: uptime, task stats, memory info."
    )]
    async fn butler_status(&self, Parameters(_args): Parameters<EmptyArgs>) -> CallToolResult {
        match status::text(&self.data_root).await {
            Ok(text) => text_result(text),
            Err(error) => CallToolResult::error(vec![ContentBlock::text(error)]),
        }
    }

    #[tool(
        name = "restart_butler",
        description = "Restart the butler. Use after code changes to mcp-server or watcher."
    )]
    async fn restart_butler(&self, Parameters(_args): Parameters<EmptyArgs>) -> CallToolResult {
        restart::restart(&self.installation, &self.data_root).await
    }

    #[tool(
        name = "project_list",
        description = "List all projects with recent task summaries. Use when user sends '/project'."
    )]
    async fn project_list(&self, Parameters(_args): Parameters<EmptyArgs>) -> CallToolResult {
        let projects = match operations::read_mcp_task_projects(&self.data_root, &self.home) {
            Ok(projects) => projects,
            Err(error) => return CallToolResult::error(vec![ContentBlock::text(error)]),
        };
        if projects.is_empty() {
            return text_result("No project tasks found.".into());
        }
        let mut lines = Vec::new();
        for project in projects {
            let mut status_parts = Vec::new();
            if project.running > 0 {
                status_parts.push(format!("{} running", project.running));
            }
            status_parts.push(format!("{} done", project.done));
            if project.failed > 0 {
                status_parts.push(format!("{} failed", project.failed));
            }
            lines.push(format!(
                "📂 {} — {} tasks ({})",
                project.project,
                project.total,
                status_parts.join(", ")
            ));
            for task in project.recent {
                let icon = match task.status.as_str() {
                    "DONE" => "✅",
                    "FAILED" => "❌",
                    "RUNNING" => "⏳",
                    _ => "⏸️",
                };
                lines.push(format!("  {icon} {}", slice_utf16(&task.request, 80)));
            }
            lines.push(String::new());
        }
        text_result(lines.join("\n").trim().to_owned())
    }

    #[tool(
        name = "model_set",
        description = "Set or get the worker/butler model. Valid: gpt-6-astra, gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.5-codex, gpt-5.5, gpt-5.4, gpt-5.4-mini, auto:codex-latest. Use target to specify worker or butler."
    )]
    async fn model_set(&self, Parameters(args): Parameters<ModelSetArgs>) -> CallToolResult {
        if matches!(args.action, Some(ModelAction::List)) {
            return model::list();
        }
        let target = args.target.as_ref().map(|target| match target {
            ModelTarget::Worker => "worker",
            ModelTarget::Butler => "butler",
        });
        model::details_or_set(
            &self.installation,
            &self.data_root,
            target,
            args.model.as_deref().filter(|value| !value.is_empty()),
        )
        .await
    }

    #[tool(
        name = "memory_graph",
        description = "Query the entity relationship graph. Find connections between projects, decisions, tools, and people."
    )]
    async fn memory_graph(&self, Parameters(args): Parameters<MemoryGraphArgs>) -> CallToolResult {
        let hops = args.hops.unwrap_or(2);
        if !(1..=4).contains(&hops) {
            return CallToolResult::error(vec![ContentBlock::text("hops must be between 1 and 4")]);
        }
        let output = graph::query(
            &self.data_root,
            &args.query,
            args.entity_type.as_ref().map(GraphEntityType::as_str),
            args.project.as_deref(),
            hops,
        );
        text_result(output)
    }

    #[tool(
        name = "skill_list",
        description = "List all loaded skills with applicability notes and descriptions. Use when user sends '/skills'."
    )]
    async fn skill_list(&self, Parameters(_args): Parameters<EmptyArgs>) -> CallToolResult {
        text_result(skills::list_text(&self.installation, &self.data_root).await)
    }
}

#[tool_handler]
impl ServerHandler for McpServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(self.name.as_str(), "1.0.0"))
    }
}

fn text_result(text: String) -> CallToolResult {
    CallToolResult::success(vec![ContentBlock::text(text)])
}

fn pad_end(value: &str, target: usize) -> String {
    let length = value.encode_utf16().count();
    format!("{value}{}", " ".repeat(target.saturating_sub(length)))
}

fn slice_utf16(value: &str, target: usize) -> String {
    let units = value.encode_utf16().take(target).collect::<Vec<_>>();
    String::from_utf16_lossy(&units)
}
