//! Settings: import from other AI agents (host only). A global instruction
//! file becomes one Butler instruction under a source heading; MCP servers
//! become Butler servers with secret names as empty slots, never values.
//! Answers carry counts, home-relative file labels and server names/flags only.
use super::{HttpError, HttpState, json, read_body_with_limit};
use crate::gateway::AppMemoryCommand;
use crate::gateway::protocol::{APP_PROTOCOL_VERSION, ApiEnvelope};
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use axum::response::Response;
use butler_platform::agent_homes::{self, AgentSetup};
use butler_runtime::agent_import::{self as import, McpServer, McpServers};
use serde_json::{Value, json};
use std::sync::Arc;

/// What recent imports added, by run, so undo removes exactly that.
#[derive(Default)]
pub(super) struct AgentImports {
    runs: tokio::sync::Mutex<Vec<(String, Added)>>,
}

/// Receipts kept for undo; older runs can no longer be undone from here.
const KEPT_RUNS: usize = 8;
/// Largest request body: room for an explicit list of every server name.
const MAX_BODY_BYTES: usize = 64 * 1024;

#[derive(Default)]
struct Added {
    instructions: Vec<String>,
    servers: Vec<String>,
}

/// Everything read from one agent before anything is written.
struct Found {
    setup: AgentSetup,
    instructions: Result<Option<String>, &'static str>,
    servers: McpServers,
    unreadable: bool,
}

pub(super) async fn route(
    state: Arc<HttpState>,
    request: Request<Body>,
) -> Result<Response, HttpError> {
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let body = if method == Method::POST {
        let bytes = read_body_with_limit(request.into_body(), MAX_BODY_BYTES).await?;
        serde_json::from_slice::<Value>(&bytes).map_err(|_| HttpError::invalid_json())?
    } else {
        Value::Null
    };
    let data = match (&method, path.as_str()) {
        (&Method::GET, "/security/agent-import/sources") => sources().await?,
        (&Method::POST, "/security/agent-import/start") => start(&state, &body).await?,
        (&Method::POST, "/security/agent-import/undo") => undo(&state, &body).await?,
        _ => return Err(HttpError::public(404, "not_found", "Route not found.")),
    };
    json(
        StatusCode::OK,
        ApiEnvelope {
            protocol_version: APP_PROTOCOL_VERSION,
            data,
        },
    )
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, HttpError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| HttpError::Internal)
}

fn invalid() -> HttpError {
    HttpError::public(400, "invalid_import_request", "Choose what to import.")
}

fn read(setup: AgentSetup) -> Found {
    let instructions = match &setup.instructions {
        None => Ok(None),
        Some(file) => match agent_homes::read_source(&file.path, import::MAX_INSTRUCTION_BYTES) {
            Ok(bytes) => Ok(bytes.and_then(|bytes| {
                let body = String::from_utf8_lossy(&bytes);
                import::instruction_text(setup.agent.name(), &file.label, &body)
            })),
            Err(error) if error.kind() == std::io::ErrorKind::FileTooLarge => Err("too_large"),
            Err(_) => Err("unreadable"),
        },
    };
    let mut servers = McpServers::default();
    let mut unreadable = false;
    for (file, format) in &setup.configs {
        match agent_homes::read_source(&file.path, import::MAX_CONFIG_BYTES) {
            Ok(Some(bytes)) => match import::parse_config(*format, &bytes) {
                Ok(parsed) => servers.merge(parsed),
                Err(_) => unreadable = true,
            },
            Ok(None) => {}
            Err(_) => unreadable = true,
        }
    }
    Found {
        setup,
        instructions,
        servers,
        unreadable,
    }
}

async fn sources() -> Result<Value, HttpError> {
    let found = blocking(|| {
        agent_homes::detect()
            .into_iter()
            .map(read)
            .collect::<Vec<_>>()
    })
    .await?;
    let rows: Vec<Value> = found
        .iter()
        .map(|found| {
            let servers = &found.servers.servers;
            json!({
                "key": found.setup.agent.key(),
                "name": found.setup.agent.name(),
                "instructions": matches!(found.instructions, Ok(Some(_))),
                "instructions_file": found.setup.instructions.as_ref().map(|file| &file.label),
                "instructions_error": found.instructions.as_ref().err(),
                "servers": servers.len(),
                "needs_secret": servers.iter().filter(|server| server.needs_secret()).count(),
                "skipped": found.servers.skipped,
                "unreadable": found.unreadable,
                // What a start request can select: only an importable file.
                "items": {
                    "instructions": found.setup.instructions.iter()
                        .filter(|_| matches!(found.instructions, Ok(Some(_))))
                        .map(|file| &file.label).collect::<Vec<_>>(),
                    "servers": servers.iter().map(|server| json!({
                        "name": server.name, "needs_secret": server.needs_secret(),
                    })).collect::<Vec<_>>(),
                },
            })
        })
        .collect();
    Ok(json!({"sources": rows}))
}

async fn memory(state: &Arc<HttpState>, command: AppMemoryCommand) -> Result<Value, HttpError> {
    Ok(state
        .application
        .memory_management(command, state.shutdown.child_token())
        .await?)
}

async fn start(state: &Arc<HttpState>, body: &Value) -> Result<Value, HttpError> {
    let key = body["source"].as_str().ok_or_else(invalid)?.to_owned();
    let selection: import::ImportSelection =
        serde_json::from_value(body.clone()).map_err(|_| invalid())?;
    let mut found = blocking(move || {
        agent_homes::detect()
            .into_iter()
            .find(|setup| setup.agent.key() == key)
            .map(read)
    })
    .await?
    .ok_or_else(|| HttpError::public(404, "import_not_found", "Agent not found."))?;
    selection
        .select_servers(&mut found.servers)
        .map_err(|_| invalid())?;
    if !selection.instructions {
        found.instructions = Ok(None);
    }
    let mut added = Added::default();
    let mut counts = json!({
        "instructions": 0, "instructions_existing": 0,
        "servers": 0, "servers_existing": 0, "needs_secret": 0,
        "skipped": found.servers.skipped,
        "instructions_error": found.instructions.as_ref().err(),
    });
    let result = write(state, &found, &mut added, &mut counts).await;
    let run = uuid::Uuid::new_v4().to_string();
    counts["run_id"] = json!(run);
    let mut runs = state.agent_imports.runs.lock().await;
    runs.push((run, added));
    let excess = runs.len().saturating_sub(KEPT_RUNS);
    runs.drain(..excess);
    drop(runs);
    if let Err(error) = result {
        // What was added before the failure stays undoable under this run.
        let code = match &error {
            HttpError::Public { code, .. } => code.as_str(),
            _ => "import_failed",
        };
        butler_core::diagnostic!("[agent-import] write_failed code={code}");
        counts["error"] = json!(code);
    }
    Ok(counts)
}

async fn write(
    state: &Arc<HttpState>,
    found: &Found,
    added: &mut Added,
    counts: &mut Value,
) -> Result<(), HttpError> {
    if let Ok(Some(text)) = &found.instructions {
        let field = if add_instruction(state, text, added).await? {
            "instructions"
        } else {
            "instructions_existing"
        };
        counts[field] = json!(1);
    }
    add_servers(
        state,
        found.setup.agent.key(),
        &found.servers.servers,
        added,
        counts,
    )
    .await
}

/// Skipped when any instruction already holds the same body, whatever its
/// heading (Codex and Claude Code often share one file).
async fn add_instruction(
    state: &Arc<HttpState>,
    text: &str,
    added: &mut Added,
) -> Result<bool, HttpError> {
    let listed = memory(state, AppMemoryCommand::Instructions).await?;
    let body = import::instruction_body(text);
    let exists = listed["instructions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|row| row["text"].as_str())
        .any(|known| import::instruction_body(known) == body);
    if exists {
        return Ok(false);
    }
    let receipt = memory(
        state,
        AppMemoryCommand::RememberInstruction {
            text: text.to_owned(),
            operation_id: uuid::Uuid::new_v4().to_string(),
        },
    )
    .await?;
    if let Some(handle) = receipt["rule"].as_str() {
        added.instructions.push(handle.to_owned());
    }
    Ok(true)
}

/// Same endpoint already in Butler: skipped. Same name, other endpoint: kept
/// under a name suffixed with the agent; if that is taken too, skipped.
async fn add_servers(
    state: &Arc<HttpState>,
    agent: &str,
    servers: &[McpServer],
    added: &mut Added,
    counts: &mut Value,
) -> Result<(), HttpError> {
    use butler_models::mcp_client::normalize_server_id;
    if servers.is_empty() {
        return Ok(());
    }
    let listed = state.application.list_mcp_servers().await?;
    let mut known = listed["servers"].as_array().cloned().unwrap_or_default();
    let (mut imported, mut existing, mut secrets) = (0_u64, 0_u64, 0_u64);
    for server in servers {
        let taken = |id: &str| id.is_empty() || known.iter().any(|row| row["id"] == id);
        let id = [server.name.clone(), format!("{}-{agent}", server.name)]
            .iter()
            .map(|name| normalize_server_id(name))
            .find(|id| !taken(id));
        let duplicate = known.iter().any(|row| server.same_target(row));
        let Some(id) = id.filter(|_| !duplicate) else {
            existing += 1;
            continue;
        };
        let created = state
            .application
            .create_mcp_server(server.registry_input(&id))
            .await?;
        added.servers.push(id);
        known.push(created["server"].clone());
        imported += 1;
        secrets += u64::from(server.needs_secret());
        counts["servers"] = json!(imported);
        counts["needs_secret"] = json!(secrets);
    }
    counts["servers_existing"] = json!(existing);
    Ok(())
}

async fn undo(state: &Arc<HttpState>, body: &Value) -> Result<Value, HttpError> {
    let run = body["run_id"]
        .as_str()
        .filter(|run| uuid::Uuid::parse_str(run).is_ok())
        .ok_or_else(invalid)?;
    let added = {
        let mut runs = state.agent_imports.runs.lock().await;
        let index = runs.iter().position(|(id, _)| id == run);
        index.map(|index| runs.remove(index).1).unwrap_or_default()
    };
    let mut instructions = 0_u64;
    if !added.instructions.is_empty() {
        let listed = memory(state, AppMemoryCommand::Instructions).await?;
        let rows = listed["instructions"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        for handle in &added.instructions {
            let Some(row) = rows.iter().find(|row| row["handle"] == handle.as_str()) else {
                continue;
            };
            let command = AppMemoryCommand::DeleteInstruction {
                handle: handle.clone(),
                expected_revision: row["revision"].as_str().unwrap_or_default().to_owned(),
                project_id: row["project_id"].as_str().map(str::to_owned),
                operation_id: uuid::Uuid::new_v4().to_string(),
            };
            memory(state, command).await?;
            instructions += 1;
        }
    }
    let mut servers = 0_u64;
    for id in added.servers {
        let removed = state.application.delete_mcp_server(id).await?;
        servers += u64::from(removed["removed"] == true);
    }
    Ok(json!({"instructions": instructions, "servers": servers}))
}
