//! Project governance tools: one admitted workflow owns normalization through closeout.

mod commit_evidence;
mod evidence;
mod lifecycle;
mod options;
mod recovery;

use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Map, Value, json};
use tokio::sync::Semaphore;
use tokio_util::{sync::CancellationToken, task::TaskTracker};

use crate::btcc::BtccError;
use crate::project_ledger::{
    LedgerCommand, LedgerCommandRequest, NativeProjectLedger, ProjectLedgerReadError,
    ProjectLedgerToolScopeLookup,
};
use crate::public_text::trim_js_whitespace;
use crate::workspace::NativeCommands;

pub(crate) struct ProjectToolScope {
    pub project_id: Option<String>,
    pub workspace_path: PathBuf,
    pub installation_root: Option<PathBuf>,
}

pub(crate) struct NativeGuidedProjectTools {
    ledger: NativeProjectLedger,
    commands: NativeCommands,
    environment: Arc<HashMap<String, String>>,
    work_records: crate::work_records::WorkRecordReader,
    collation: Arc<crate::locale::LocaleCollation>,
    tasks: TaskTracker,
    admission: Mutex<bool>,
    permits: Arc<Semaphore>,
}

impl NativeGuidedProjectTools {
    pub(in crate::host) fn ledger(&self) -> NativeProjectLedger {
        self.ledger.clone()
    }

    pub(crate) fn new(
        ledger: NativeProjectLedger,
        commands: NativeCommands,
        environment: Arc<HashMap<String, String>>,
        work_records: crate::work_records::WorkRecordReader,
        collation: Arc<crate::locale::LocaleCollation>,
    ) -> Self {
        Self {
            ledger,
            commands,
            environment,
            work_records,
            collation,
            tasks: TaskTracker::new(),
            admission: Mutex::new(true),
            permits: Arc::new(Semaphore::new(4)),
        }
    }

    pub(crate) fn supports(name: &str) -> bool {
        matches!(
            name,
            "get_work_dashboard"
                | "project_ledger_status"
                | "project_ledger_index"
                | "project_ledger_list"
                | "project_ledger_show"
                | "project_ledger_check"
                | "project_ledger_render"
                | "inspect_project_status"
                | "query_project_work"
                | "render_project_dashboard"
                | "project_ledger_create"
                | "project_ledger_update"
                | "project_ledger_work_update"
                | "project_ledger_work_complete"
                | "project_ledger_task_update"
                | "project_ledger_task_complete"
                | "project_ledger_attempt_start"
                | "project_ledger_attempt_succeed"
                | "project_ledger_attempt_fail"
                | "complete_project_work"
        )
    }

    pub(crate) async fn execute(
        self: &Arc<Self>,
        name: &str,
        args: &Map<String, Value>,
        scope: ProjectToolScope,
    ) -> Result<Value, BtccError> {
        let name = name.to_owned();
        let args = args.clone();
        let task = {
            let open = self.admission.lock();
            if !*open {
                return Err(error("project_tools_closed"));
            }
            let owner = self.clone();
            self.tasks.spawn(async move {
                let _permit = owner
                    .permits
                    .clone()
                    .acquire_owned()
                    .await
                    .map_err(|_| error("project_tools_closed"))?;
                owner.run(&name, args, scope).await
            })
        };
        task.await
            .map_err(|_| error("project_tool_worker_failed"))?
    }

    pub(crate) async fn close(&self) {
        {
            let mut open = self.admission.lock();
            *open = false;
            self.tasks.close();
        }
        self.tasks.wait().await;
    }

    async fn run(
        &self,
        name: &str,
        args: Map<String, Value>,
        scope: ProjectToolScope,
    ) -> Result<Value, BtccError> {
        if name == "get_work_dashboard" {
            let reader = self.work_records.clone();
            let collation = self.collation.clone();
            let debug = args.get("debug") == Some(&Value::Bool(true));
            let limit = args.get("limit").and_then(Value::as_f64);
            let mut result =
                tokio::task::spawn_blocking(move || reader.dashboard(debug, limit, &collation))
                    .await
                    .map_err(|_| error("work_dashboard_worker_failed"))?
                    .map_err(|_| error("work_dashboard_unavailable"))?;
            result["ok"] = Value::Bool(true);
            return Ok(evidence::attach(name, &args, Path::new(""), result));
        }
        let name = if name == "complete_project_work" {
            "project_ledger_work_complete"
        } else {
            name
        };
        let native = name.starts_with("project_ledger_");
        let mut args = if native {
            options::acceptance(&args)
        } else {
            args
        };
        if native {
            let fallback = text(&args, "project_path").map(PathBuf::from);
            let workspace = (!scope.workspace_path.as_os_str().is_empty())
                .then_some(scope.workspace_path.as_path())
                .or(fallback.as_deref())
                .or(scope.installation_root.as_deref());
            args = match commit_evidence::normalize(
                name,
                &args,
                workspace,
                &self.commands,
                &self.environment,
                CancellationToken::new(),
            )
            .await
            {
                Ok(args) => args,
                Err(result) => return Ok(result),
            };
        }
        let explicit: Vec<_> = ["project_ref", "project_path"]
            .into_iter()
            .filter_map(|key| text(&args, key))
            .collect();
        let active = scope
            .project_id
            .as_deref()
            .map(trim_js_whitespace)
            .filter(|id| !id.is_empty());
        if active.is_some_and(|id| explicit.iter().any(|reference| *reference != id)) {
            return Ok(json!({"ok":false,"error":{
                "code":"project_ledger_project_scope_mismatch",
                "message":"Explicit Project Ledger reference must match the active project id or be omitted."
            }}));
        }
        let root = self
            .ledger
            .resolve_tool_scope(ProjectLedgerToolScopeLookup {
                app_project_id: scope.project_id,
                workspace_path: (!scope.workspace_path.as_os_str().is_empty())
                    .then_some(scope.workspace_path),
                explicit_reference: explicit.first().map(|value| (*value).to_owned()),
            })
            .await
            .map_err(|_| error("project_ledger_project_resolution_failed"))?;
        let (command, command_options) = options::command(name, &args)?;
        let mut result = match lifecycle::execute(
            &self.ledger,
            &root,
            name,
            &args,
            command,
            command_options.clone(),
        )
        .await
        .map_err(ledger_error)?
        {
            Some(result) => result,
            None => self::command(&self.ledger, &root, command, command_options)
                .await
                .map_err(ledger_error)?,
        };
        if native {
            result = recovery::attach(name, &args, result);
        }
        if matches!(name, "project_ledger_create" | "project_ledger_update") {
            result = plan_body(&self.ledger, &root, &args, result)
                .await
                .map_err(ledger_error)?;
        }
        if result.get("ok") == Some(&Value::Bool(true))
            && matches!(
                name,
                "project_ledger_create"
                    | "project_ledger_update"
                    | "project_ledger_work_update"
                    | "project_ledger_work_complete"
                    | "project_ledger_task_update"
                    | "project_ledger_task_complete"
            )
        {
            result = lifecycle::closeout(&self.ledger, &root, result)
                .await
                .map_err(ledger_error)?;
        } else {
            result = evidence::attach(name, &args, &root, result);
        }
        Ok(result)
    }
}

fn text<'a>(args: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .map(trim_js_whitespace)
        .filter(|value| !value.is_empty())
}
fn ledger_error(failure: ProjectLedgerReadError) -> BtccError {
    let code = match failure {
        ProjectLedgerReadError::Resolution(code)
        | ProjectLedgerReadError::RecordShow(code)
        | ProjectLedgerReadError::Owner(code)
        | ProjectLedgerReadError::DashboardInternal(code)
        | ProjectLedgerReadError::DashboardUnavailable(code) => code,
        ProjectLedgerReadError::DashboardChanged => "project_ledger_changed",
    };
    error(code)
}
fn error(code: &'static str) -> BtccError {
    BtccError::new(code, code)
}

/// Bound each former CLI response before presentation and mutation closeout.
pub(super) async fn command(
    ledger: &NativeProjectLedger,
    root: &Path,
    command: LedgerCommand,
    options: Value,
) -> Result<Value, ProjectLedgerReadError> {
    let result = ledger
        .execute_command(LedgerCommandRequest {
            project_root: root.to_path_buf(),
            command,
            options,
        })
        .await?;
    const MAX_CLI_OUTPUT_BYTES: usize = 1_048_576;
    match crate::json::stringify(&result) {
        Ok(output) if output.len() <= MAX_CLI_OUTPUT_BYTES => Ok(result),
        Ok(_) => Ok(
            json!({"ok":false,"error":{"code":"project_ledger_output_limit",
            "message":"Project Ledger output exceeded the transport limit. Narrow the query."}}),
        ),
        Err(_) => Ok(
            json!({"ok":false,"error":{"code":"project_ledger_invalid_json",
            "message":"Project Ledger returned invalid JSON"}}),
        ),
    }
}

async fn plan_body(
    ledger: &NativeProjectLedger,
    root: &Path,
    args: &Map<String, Value>,
    mut result: Value,
) -> Result<Value, ProjectLedgerReadError> {
    if result.get("ok") != Some(&Value::Bool(true))
        || args.get("kind").and_then(Value::as_str) != Some("plan")
    {
        return Ok(result);
    }
    if result
        .pointer("/data/body")
        .and_then(Value::as_str)
        .is_some_and(|body| !trim_js_whitespace(body).is_empty())
    {
        return Ok(result);
    }
    if let Some(body) = args
        .get("body")
        .and_then(Value::as_str)
        .filter(|body| !trim_js_whitespace(body).is_empty())
    {
        result["data"]["body"] = body.into();
        return Ok(result);
    }
    let id = result
        .pointer("/data/id")
        .and_then(Value::as_str)
        .map(trim_js_whitespace)
        .filter(|id| !id.is_empty())
        .or_else(|| text(args, "id"));
    if let Some(id) = id {
        let shown = command(
            ledger,
            root,
            LedgerCommand::Show,
            json!({"kind":"plan","id":id,"body":true}),
        )
        .await?;
        if let Some(body) = shown
            .pointer("/data/body")
            .and_then(Value::as_str)
            .map(trim_js_whitespace)
            .filter(|body| !body.is_empty())
        {
            result["data"]["body"] = body.into();
        }
    }
    Ok(result)
}
