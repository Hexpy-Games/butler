//! Reviewed Project Ledger record effects over the existing durable EffectService.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::btcc::{
    AdapterOutcome, BlockerRelation, EffectAdapter, EffectAdapterError, EffectBlocker,
    EffectFailure, EffectFuture, PlanBinding, ResolvedProjectWorkScope,
};
use crate::json::JsonDocument;
use crate::project_ledger::{
    LedgerEffectReconciliation, LedgerEffectRequest, NativeProjectLedger,
    ProjectLedgerRecordUpdate, ProjectLedgerToolScopeLookup,
};
use crate::workspace::WorkspaceReference;

use super::super::NativeGuidedTools;
use super::{ledger_input, ledger_legacy};

pub(super) async fn prepare(
    owner: &NativeGuidedTools,
    name: &str,
    args: &serde_json::Map<String, Value>,
) -> Result<(String, Value, std::sync::Arc<dyn EffectAdapter>), crate::btcc::BtccError> {
    if !owner.binding.enable_project_ledger_effects {
        return Err(crate::btcc::BtccError::new(
            "project_ledger_active_context_required",
            "Project Ledger effects require a bounded project Turn.",
        ));
    }
    let project_id = owner.binding.memory.project_id.as_deref().ok_or_else(|| {
        crate::btcc::BtccError::new(
            "project_ledger_active_context_required",
            "Project Ledger effects require a bounded project Turn.",
        )
    })?;
    let (target, input) = ledger_input::prepare(name, args, project_id)?;
    let workspace = owner
        .binding
        .workspace_reference
        .as_ref()
        .map(WorkspaceReference::get)
        .transpose()
        .map_err(|_| {
            crate::btcc::BtccError::new(
                "project_ledger_active_context_required",
                "The active workspace is unavailable.",
            )
        })?
        .unwrap_or_else(|| owner.binding.workspace_path.clone());
    let ledger = owner.project.ledger();
    let root = ledger
        .resolve_tool_scope(ProjectLedgerToolScopeLookup {
            app_project_id: Some(project_id.to_owned()),
            workspace_path: Some(workspace.clone()),
            explicit_reference: None,
        })
        .await
        .map_err(|_| {
            crate::btcc::BtccError::new(
                "project_ledger_active_context_required",
                "Project Ledger changes require the exact bounded project and workspace context.",
            )
        })?;
    let adapter = LedgerEffectAdapter {
        name: name.to_owned(),
        target: target.clone(),
        project_id: project_id.to_owned(),
        root,
        workspace,
        workspace_reference: owner.binding.workspace_reference.clone(),
        ledger,
    };
    adapter
        .normalize_target(&target)
        .map_err(|error| crate::btcc::BtccError::new(error.code, error.message))?;
    Ok((target, input, std::sync::Arc::new(adapter)))
}

pub(super) struct LedgerEffectAdapter {
    pub name: String,
    pub target: String,
    pub project_id: String,
    pub root: PathBuf,
    pub workspace: PathBuf,
    pub workspace_reference: Option<WorkspaceReference>,
    pub ledger: NativeProjectLedger,
}

impl LedgerEffectAdapter {
    fn current_workspace(&self) -> Result<PathBuf, EffectAdapterError> {
        self.workspace_reference
            .as_ref()
            .map(WorkspaceReference::get)
            .transpose()
            .map_err(|_| binding_error())
            .map(|value| value.unwrap_or_else(|| self.workspace.clone()))
    }

    async fn binding_current(&self) -> bool {
        let Ok(workspace) = self.current_workspace() else {
            return false;
        };
        self.ledger
            .resolve_tool_scope(ProjectLedgerToolScopeLookup {
                app_project_id: Some(self.project_id.clone()),
                workspace_path: Some(workspace),
                explicit_reference: None,
            })
            .await
            .is_ok_and(|root| root == self.root)
    }

    async fn initialized_for_dispatch(&self) -> Result<bool, EffectAdapterError> {
        if initialized(&self.root) {
            return Ok(true);
        }
        if self.name != "project_ledger_create" {
            return Ok(false);
        }
        let id = self
            .root
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(binding_error)?
            .to_owned();
        self.ledger
            .ensure_project_ledger(
                ResolvedProjectWorkScope {
                    app_project_id: self.project_id.clone(),
                    ledger_project_id: id.clone(),
                    ledger_root: self.root.clone(),
                },
                id,
            )
            .await
            .map_err(|error| {
                adapter_error(
                    "project_ledger_effect_dispatch_uncertain",
                    &format!("Project Ledger initialization failed: {}", error.code()),
                )
            })?;
        if !self.binding_current().await || !initialized(&self.root) {
            return Err(adapter_error(
                "project_ledger_effect_dispatch_uncertain",
                "Project Ledger identity changed before the reviewed effect was applied",
            ));
        }
        Ok(true)
    }

    fn request(&self, input: &Value, key: &str) -> Result<LedgerEffectRequest, EffectFailure> {
        let updates = match ledger_legacy::updates(input)? {
            Some(updates) => updates,
            None => vec![
                serde_json::from_value::<ProjectLedgerRecordUpdate>(input.clone()).map_err(
                    |_| {
                        EffectFailure::policy(
                            "project_ledger_effect_input_invalid",
                            "Project Ledger effect input is invalid",
                        )
                    },
                )?,
            ],
        };
        Ok(LedgerEffectRequest {
            project_root: self.root.clone(),
            effect_key: key.to_owned(),
            updates,
        })
    }
}

impl EffectAdapter for LedgerEffectAdapter {
    fn capability(&self) -> &str {
        &self.name
    }
    fn binding(&self) -> PlanBinding {
        PlanBinding::AcceptedPlan
    }
    fn normalize_target(&self, target: &str) -> Result<String, EffectFailure> {
        let normalized = crate::public_text::trim_js_whitespace(target);
        if !valid_target(normalized) || normalized != self.target {
            return Err(EffectFailure::policy(
                "project_ledger_effect_target_invalid",
                "Project Ledger effect target must be project-ledger:<kind>:<id>",
            ));
        }
        Ok(normalized.to_owned())
    }
    fn sanitize_target(&self, target: &str) -> Result<String, EffectFailure> {
        self.normalize_target(target)
    }
    fn normalize_input(&self, input: &Value) -> Result<Value, EffectFailure> {
        if !input.is_object() {
            return Err(EffectFailure::policy(
                "project_ledger_effect_input_invalid",
                "Project Ledger effect input must be an object",
            ));
        }
        Ok(input.clone())
    }
    fn classify<'a>(
        &'a self,
        blocker: &'a EffectBlocker,
        target: &'a str,
        input: &'a Value,
    ) -> Option<EffectFuture<'a, BlockerRelation>> {
        Some(Box::pin(async move {
            Ok(ledger_legacy::classify(
                &self.ledger,
                self.root.clone(),
                &self.name,
                blocker,
                target,
                input,
            )
            .await)
        }))
    }
    fn dispatch<'a>(
        &'a self,
        _target: &'a str,
        input: &'a Value,
        key: &'a str,
        _signal: &'a CancellationToken,
    ) -> EffectFuture<'a, AdapterOutcome> {
        Box::pin(async move {
            if !self.binding_current().await {
                return Ok(AdapterOutcome::NotApplied(binding_error()));
            }
            let request = self.request(input, key)?;
            let result = match self.initialized_for_dispatch().await {
                Ok(true) => self
                    .ledger
                    .apply_record_effect(request.clone())
                    .await
                    .map_err(|error| adapter_error(error.code(), error.message())),
                Ok(false) => return Ok(AdapterOutcome::NotApplied(not_initialized())),
                Err(error) => Err(error),
            };
            match result {
                Ok(result) => public(result).map(AdapterOutcome::Applied),
                Err(error) => match self.ledger.reconcile_record_effect(request).await {
                    Ok(LedgerEffectReconciliation::Applied(result)) => {
                        public(result).map(AdapterOutcome::Applied)
                    }
                    Ok(LedgerEffectReconciliation::NotApplied) => {
                        Ok(AdapterOutcome::NotApplied(error))
                    }
                    Ok(LedgerEffectReconciliation::Uncertain) | Err(_) => Ok(uncertain()),
                },
            }
        })
    }
    fn reconcile<'a>(
        &'a self,
        _target: &'a str,
        input: &'a Value,
        key: &'a str,
        _signal: &'a CancellationToken,
        _attempts: i64,
        _prior: Option<&'a crate::btcc::EffectError>,
    ) -> EffectFuture<'a, AdapterOutcome> {
        Box::pin(async move {
            if !self.binding_current().await {
                return Ok(AdapterOutcome::Uncertain(Some(binding_error())));
            }
            if !initialized(&self.root) {
                return Ok(AdapterOutcome::NotApplied(not_initialized()));
            }
            let request = self.request(input, key)?;
            match self.ledger.reconcile_record_effect(request).await {
                Ok(LedgerEffectReconciliation::Applied(result)) => {
                    public(result).map(AdapterOutcome::Applied)
                }
                Ok(LedgerEffectReconciliation::NotApplied) => Ok(AdapterOutcome::NotApplied(
                    adapter_error("not_applied", "not applied"),
                )),
                Ok(LedgerEffectReconciliation::Uncertain) | Err(_) => Ok(uncertain()),
            }
        })
    }
}

fn public(result: Value) -> Result<JsonDocument, EffectFailure> {
    let field = |name| {
        result.get(name).cloned().ok_or_else(|| {
            EffectFailure::adapter("Project Ledger publication result is incomplete")
        })
    };
    let publication_id = field("publicationId")?;
    let updated_records = field("updatedRecords")?;
    let current = field("currentHead")?;
    let source_sha256 = current.get("sourceSha256").cloned().ok_or_else(|| {
        EffectFailure::adapter("Project Ledger publication result has no current head")
    })?;
    let source_file_count = current.get("sourceFileCount").cloned().ok_or_else(|| {
        EffectFailure::adapter("Project Ledger publication result has no current head")
    })?;
    let value = json!({
        "ok":true, "effect":"project_ledger_publication",
        "publication_id":publication_id,
        "updated_records":updated_records,
        "source_sha256":source_sha256,
        "source_file_count":source_file_count,
    });
    JsonDocument::from_value(&value).map_err(|error| EffectFailure::adapter(error.to_string()))
}

fn valid_target(target: &str) -> bool {
    let Some(rest) = target.strip_prefix("project-ledger:") else {
        return false;
    };
    let Some((kind, id)) = rest.split_once(':') else {
        return false;
    };
    let mut kind_bytes = kind.bytes();
    if !kind_bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_lowercase())
        || !kind_bytes.all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
        })
        || id.is_empty()
        || id.len() > 160
    {
        return false;
    }
    id.bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn initialized(root: &Path) -> bool {
    root.join("project.json").exists() && root.join("ledger.jsonl").exists()
}

fn adapter_error(code: &str, message: &str) -> EffectAdapterError {
    let mut error = EffectAdapterError::new(code, message);
    error.recoverable = Some(true);
    error
}

fn binding_error() -> EffectAdapterError {
    adapter_error(
        "project_ledger_active_context_required",
        "Project Ledger changes require the exact bounded project and workspace context. Refresh the project session before retrying.",
    )
}

fn not_initialized() -> EffectAdapterError {
    adapter_error(
        "project_ledger_not_initialized",
        "The active Project Ledger has no records yet. Create the first reviewed record before using update or completion tools.",
    )
}

fn uncertain() -> AdapterOutcome {
    AdapterOutcome::Uncertain(Some(adapter_error(
        "project_ledger_effect_uncertain",
        "The Project Ledger publication state could not be verified safely.",
    )))
}
