//! `switch_folder` and the automatic move into a worktree a command created:
//! the session's working folder becomes the new folder for every later tool,
//! in this turn and the next ones.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use butler_core::json::JsonDocument;
use butler_turn::btcc::{
    AccessMode, AdapterOutcome, BtccError, EffectAdapter, EffectAdapterError, EffectFailure,
    EffectFuture, GuidedInvocation, ModelRoundToolCall, PlanBinding, RuntimeTurnEventInput,
};
use butler_turn::workspace::{
    FolderInspection, FolderRelation, FolderRoots, SessionFolders, SwitchSessionFolder,
    SwitchSessionFolderResult, WorkspaceReference,
};

use super::super::GuidedTools;

const CAPABILITY: &str = "switch_folder";
const MAX_REASON_CHARS: usize = 200;

/// Resolves the requested folder and prepares its move.
pub(super) async fn prepare(
    owner: &GuidedTools,
    args: &Map<String, Value>,
) -> Result<(String, Value, Arc<dyn EffectAdapter>), BtccError> {
    let path = args
        .get("path")
        .and_then(Value::as_str)
        .map(butler_core::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| BtccError::relayed("invalid_arguments", "switch_folder requires a path."))?;
    let reason: String = args
        .get("reason")
        .and_then(Value::as_str)
        .map(butler_core::public_text::trim_js_whitespace)
        .unwrap_or_default()
        .chars()
        .take(MAX_REASON_CHARS)
        .collect();
    let inspection = inspect(owner, path).await?;
    let consented = consent(owner, inspection.relation);
    let target = format!("folder:{}", inspection.path);
    let input = json!({
        "path": inspection.path,
        "reason": reason,
        "relation": inspection.relation.as_str(),
    });
    Ok((
        target.clone(),
        input,
        Arc::new(effect(owner, target, consented)?),
    ))
}

/// How the folder a `switch_folder` call (or its prepared input) names
/// relates to the current folder; `None` when it can never be one.
pub(in crate::host::guided::tools) async fn relation(
    owner: &GuidedTools,
    args: &Value,
) -> Option<FolderRelation> {
    let path = args["path"]
        .as_str()
        .map(butler_core::public_text::trim_js_whitespace)
        .filter(|value| !value.is_empty())?;
    inspect(owner, path).await.ok().map(|found| found.relation)
}

async fn inspect(owner: &GuidedTools, path: &str) -> Result<FolderInspection, BtccError> {
    let current = owner.current_workspace()?;
    let roots = FolderRoots {
        butler_data: &owner.binding.butler_data,
        protected_roots: &owner.binding.protected_ledger_roots,
        installation_root: owner.binding.installation_root.as_deref(),
    };
    owner
        .session_worktrees
        .folders()
        .inspect(&current, path, roots, CancellationToken::new())
        .await
        .map_err(BtccError::from)?
        .map_err(|refusal| {
            BtccError::relayed(
                refusal.code(),
                "This folder cannot be the working folder: it must be an existing folder outside Butler's data, credentials and private metadata.",
            )
        })
}

/// A move within the folder (or its repository) keeps the folder's consent.
/// A move elsewhere outside full access runs only after the user approved
/// it, which is consent; full access alone is not.
fn consent(owner: &GuidedTools, relation: FolderRelation) -> bool {
    if relation.contained() {
        *owner.folder_consent.lock()
    } else {
        owner.binding.access_mode != AccessMode::FullAccess
    }
}

fn effect(
    owner: &GuidedTools,
    target: String,
    consented: bool,
) -> Result<SessionFolderEffect, BtccError> {
    let reference = owner.binding.workspace_reference.clone().ok_or_else(|| {
        BtccError::relayed(
            "session_workspace_unavailable",
            "Session workspace unavailable",
        )
    })?;
    Ok(SessionFolderEffect {
        folders: owner.session_worktrees.folders(),
        session_id: owner.binding.source_session_id.clone(),
        reference,
        consent: owner.folder_consent.clone(),
        consented,
        target,
    })
}

struct SessionFolderEffect {
    folders: SessionFolders,
    session_id: String,
    reference: WorkspaceReference,
    consent: Arc<Mutex<bool>>,
    consented: bool,
    target: String,
}

impl SessionFolderEffect {
    async fn run(&self, input: &Value) -> AdapterOutcome {
        let (Some(path), Some(relation)) = (
            input["path"].as_str(),
            input["relation"].as_str().and_then(FolderRelation::parse),
        ) else {
            return AdapterOutcome::NotApplied(adapter("invalid_arguments"));
        };
        match self.apply(path, relation).await {
            Ok(value) => match JsonDocument::from_value(&value) {
                Ok(value) => AdapterOutcome::Applied(value),
                Err(_) => AdapterOutcome::Uncertain(Some(adapter("folder_switch_result_invalid"))),
            },
            Err(outcome) => outcome,
        }
    }

    async fn apply(&self, path: &str, relation: FolderRelation) -> Result<Value, AdapterOutcome> {
        let switched = self
            .folders
            .switch(SwitchSessionFolder {
                session_id: self.session_id.clone(),
                path: path.to_owned(),
                relation,
                consented: self.consented,
            })
            .await
            .map_err(|error| {
                AdapterOutcome::Uncertain(Some(EffectAdapterError::new(
                    error.code(),
                    "The working folder may not have moved; check it before continuing.",
                )))
            })?;
        let previous = match switched {
            SwitchSessionFolderResult::Switched { previous_path, .. } => previous_path,
            SwitchSessionFolderResult::Unchanged { path } => path,
            SwitchSessionFolderResult::Missing => {
                return Err(AdapterOutcome::NotApplied(adapter(
                    "session_binding_required",
                )));
            }
            SwitchSessionFolderResult::Changed => {
                return Err(AdapterOutcome::NotApplied(adapter(
                    "session_binding_changed",
                )));
            }
        };
        self.reference
            .set(path)
            .map_err(|error| AdapterOutcome::Uncertain(Some(adapter(error.code()))))?;
        *self.consent.lock() = self.consented;
        Ok(json!({
            "ok": true,
            "working_folder": path,
            "previous_folder": previous,
            "relation": relation.as_str(),
            "note": "Relative paths, commands and access checks now use this folder, in later turns too.",
        }))
    }
}

impl EffectAdapter for SessionFolderEffect {
    fn capability(&self) -> &'static str {
        CAPABILITY
    }

    fn binding(&self) -> PlanBinding {
        PlanBinding::AcceptedPlan
    }

    fn normalize_target(&self, target: &str) -> Result<String, EffectFailure> {
        (target == self.target)
            .then(|| target.to_owned())
            .ok_or_else(|| policy("folder_switch_target_changed"))
    }

    fn sanitize_target(&self, target: &str) -> Result<String, EffectFailure> {
        self.normalize_target(target)
    }

    fn normalize_input(&self, input: &Value) -> Result<Value, EffectFailure> {
        let path = input["path"].as_str().unwrap_or_default();
        (format!("folder:{path}") == self.target)
            .then(|| {
                json!({
                    "path": path,
                    "reason": input["reason"].as_str().unwrap_or_default(),
                    "relation": input["relation"].as_str().unwrap_or_default(),
                })
            })
            .ok_or_else(|| policy("folder_switch_input_changed"))
    }

    fn dispatch<'a>(
        &'a self,
        target: &'a str,
        input: &'a Value,
        _: &'a str,
        _: &'a CancellationToken,
    ) -> EffectFuture<'a, AdapterOutcome> {
        Box::pin(async move {
            if target != self.target {
                return Ok(AdapterOutcome::NotApplied(adapter(
                    "folder_switch_target_changed",
                )));
            }
            Ok(self.run(input).await)
        })
    }

    fn reconcile<'a>(
        &'a self,
        target: &'a str,
        input: &'a Value,
        _: &'a str,
        _: &'a CancellationToken,
        attempts: i64,
        _: Option<&'a butler_turn::btcc::EffectError>,
    ) -> EffectFuture<'a, AdapterOutcome> {
        Box::pin(async move {
            if attempts == 0 {
                return Ok(AdapterOutcome::NotApplied(adapter("not_applied")));
            }
            if target != self.target {
                return Ok(AdapterOutcome::Uncertain(Some(adapter(
                    "folder_switch_target_changed",
                ))));
            }
            // Moving to the same folder again is idempotent.
            Ok(self.run(input).await)
        })
    }
}

/// Whether `command` runs `git … worktree add`; only then does a command
/// pay for listing worktrees before and after it runs.
pub(super) fn adds_worktree(command: &str) -> bool {
    command.split([';', '&', '|', '\n']).any(|segment| {
        let words = butler_platform::command_sandbox::path_tokens(segment);
        let program = words
            .iter()
            .find(|word| !word.contains('='))
            .map(|word| word.rsplit(['/', '\\']).next().unwrap_or(word));
        matches!(program, Some("git" | "git.exe"))
            && words
                .windows(2)
                .any(|pair| pair[0] == "worktree" && pair[1] == "add")
    })
}

/// The directory a `run_command` call runs in.
pub(super) fn command_directory(owner: &GuidedTools, args: &Map<String, Value>) -> Option<PathBuf> {
    let root = owner.current_workspace().ok()?;
    let cwd = args.get("cwd").and_then(Value::as_str).unwrap_or(".");
    butler_platform::tool_paths::parse(&root, cwd)
        .ok()
        .map(|relative| root.join(relative))
}

/// The worktrees of the repository `cwd` is in.
pub(super) async fn worktrees(owner: &GuidedTools, cwd: &Path) -> Option<Vec<PathBuf>> {
    owner
        .session_worktrees
        .folders()
        .worktrees(cwd, CancellationToken::new())
        .await
        .ok()
        .flatten()
}

/// After a successful command that added exactly one worktree, the session
/// works in it: Git's own worktree list (before and after) names it, and it
/// is a worktree of the same repository, so the move keeps the folder's
/// consent and asks nothing. The result tells the model where it now works.
pub(super) async fn follow_new_worktree(
    owner: &GuidedTools,
    invocation: &GuidedInvocation<'_>,
    call: &ModelRoundToolCall,
    (cwd, before): (PathBuf, Vec<PathBuf>),
    result: JsonDocument,
) -> JsonDocument {
    if result.field("ok").ok().flatten() != Some("true")
        || result.field("authority_pending").ok().flatten() == Some("true")
    {
        return result;
    }
    let Some(after) = worktrees(owner, &cwd).await else {
        return result;
    };
    let added: Vec<_> = after.iter().filter(|path| !before.contains(path)).collect();
    let [created] = added.as_slice() else {
        return result;
    };
    let created = created.to_string_lossy().into_owned();
    let note = match switch_into(owner, &created).await {
        Ok(()) => {
            announce(invocation, call, &created).await;
            json!({"working_folder": created, "switched": true,
                "note": "The new worktree is now this conversation's working folder."})
        }
        Err(code) => json!({"new_worktree": created, "switched": false, "error": code,
            "note": "Call switch_folder with this path to work in it."}),
    };
    attach(result, note)
}

async fn switch_into(owner: &GuidedTools, path: &str) -> Result<(), String> {
    let inspection = inspect(owner, path)
        .await
        .map_err(|error| error.code().to_owned())?;
    if !inspection.relation.contained() {
        return Err("folder_switch_requires_approval".into());
    }
    let consented = consent(owner, inspection.relation);
    let effect = effect(owner, format!("folder:{}", inspection.path), consented)
        .map_err(|error| error.code().to_owned())?;
    effect
        .apply(&inspection.path, inspection.relation)
        .await
        .map(drop)
        .map_err(|_| "folder_switch_failed".to_owned())
}

/// Shows the move as its own activity row ("작업 폴더 이동: <path>").
async fn announce(invocation: &GuidedInvocation<'_>, call: &ModelRoundToolCall, path: &str) {
    let id = format!("{}:folder", call.id);
    for (kind, status) in [("tool.started", "started"), ("tool.completed", "completed")] {
        let mut event = RuntimeTurnEventInput::new(kind);
        event.payload = json!({
            "safeLabel": CAPABILITY, "toolName": CAPABILITY, "toolCallId": id,
            "activityKind": "used_tool", "bridgePhase": "btcc_operation",
            "semanticBlockId": format!("tool-{id}"), "operationStatus": status,
            "inputLabel": path,
        })
        .as_object()
        .cloned();
        let _ = invocation.progress.emit(event).await;
    }
}

fn attach(result: JsonDocument, note: Value) -> JsonDocument {
    let Ok(mut value) = serde_json::from_str::<Value>(result.as_str()) else {
        return result;
    };
    let Some(object) = value.as_object_mut() else {
        return result;
    };
    object.insert("working_folder_change".into(), note);
    JsonDocument::from_value(&value).unwrap_or(result)
}

fn policy(code: &str) -> EffectFailure {
    EffectFailure::policy(code.to_owned(), "Working folder input is invalid")
}

fn adapter(code: &str) -> EffectAdapterError {
    EffectAdapterError::new(code, "The working folder was not moved")
}
