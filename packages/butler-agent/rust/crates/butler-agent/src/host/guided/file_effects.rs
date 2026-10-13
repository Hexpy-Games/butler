//! Per-Turn preparation for registered workspace mutations through durable Effects.

mod edit;

use std::sync::Arc;

use serde_json::Value;

use butler_runtime::capabilities::Capabilities;
use butler_turn::btcc::{
    BtccError, EffectAdapter, EffectJournal, WorkView, WorkspaceFileEffectAdapter,
};
use butler_turn::workspace::EffectFileScope;

use crate::host::{RegisteredEdit, RegisteredWrite, RegisteredWriteContext};

pub(crate) struct PreparedGuidedFileEffect {
    pub target: String,
    pub input: Value,
    pub adapter: Arc<dyn EffectAdapter>,
}

pub(crate) struct GuidedFileEffects {
    scope: EffectFileScope,
    capabilities: Arc<Capabilities>,
    context: RegisteredWriteContext,
    registered_write: Arc<RegisteredWrite>,
    registered_edit: Arc<RegisteredEdit>,
}

impl GuidedFileEffects {
    pub(crate) fn new(
        capabilities: Arc<Capabilities>,
        context: RegisteredWriteContext,
        scope: EffectFileScope,
    ) -> Self {
        Self {
            scope,
            registered_edit: Arc::new(RegisteredEdit::new(capabilities.clone(), context.clone())),
            registered_write: Arc::new(RegisteredWrite::new(capabilities.clone(), context.clone())),
            capabilities,
            context,
        }
    }

    /// The write scope in the current working folder; a folder switch moves
    /// it mid-turn.
    fn scope(&self) -> EffectFileScope {
        let mut scope = self.scope.clone();
        if let Some(path) = self
            .context
            .workspace_reference
            .as_ref()
            .and_then(|reference| reference.get().ok())
        {
            scope.workspace = path;
        }
        scope
    }

    /// The same effects for writes that run without approval because their
    /// targets are inside the project: every guard re-checks containment,
    /// secrets and symlink escapes at the moment it touches the file.
    pub(crate) fn contained(&self) -> Self {
        let mut context = self.context.clone();
        context.contained = true;
        let mut scope = self.scope.clone();
        scope.contained = true;
        Self::new(self.capabilities.clone(), context, scope)
    }

    pub(crate) async fn prepare(
        &self,
        name: &str,
        args: &Value,
        work: &WorkView,
        occurrence: &str,
        journal: &dyn EffectJournal,
    ) -> Result<PreparedGuidedFileEffect, BtccError> {
        match name {
            "write_file" => self.prepare_write(args).await,
            "edit_file" => edit::prepare(self, args, work, occurrence, journal).await,
            _ => Err(BtccError::relayed(
                "guided_file_effect_unbound",
                "Unsupported workspace file effect",
            )),
        }
    }

    pub(crate) async fn prepare_write(
        &self,
        args: &Value,
    ) -> Result<PreparedGuidedFileEffect, BtccError> {
        let scope = self.scope();
        if let Some(path) = args.get("path").and_then(Value::as_str)
            && let Err(error) = butler_turn::workspace::guard_effect_file(&scope, path).await
            && error.code() == "protected_path"
        {
            // Refuse protected data before asking for approval. Other boundary
            // failures retain the file adapter's durable effect outcome.
            return Err(BtccError::relayed(error.code(), error.message()));
        }
        let adapter: Arc<dyn EffectAdapter> = Arc::new(WorkspaceFileEffectAdapter::new(
            scope,
            self.registered_write.clone(),
        ));
        let input = adapter
            .normalize_input(args)
            .map_err(butler_turn::btcc::BtccError::from)?;
        let path = input.get("path").and_then(Value::as_str).ok_or_else(|| {
            BtccError::relayed(
                "write_file_effect_invalid",
                "Normalized write_file path unavailable",
            )
        })?;
        Ok(PreparedGuidedFileEffect {
            target: format!("workspace:{path}"),
            input,
            adapter,
        })
    }
}
