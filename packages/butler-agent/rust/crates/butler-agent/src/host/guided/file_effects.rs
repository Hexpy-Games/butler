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
            registered_write: Arc::new(RegisteredWrite::new(capabilities, context)),
        }
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
        if let Some(path) = args.get("path").and_then(Value::as_str) {
            butler_turn::workspace::guard_effect_file(&self.scope, path)
                .await
                .map_err(|error| BtccError::relayed(error.code(), error.message()))?;
        }
        let adapter: Arc<dyn EffectAdapter> = Arc::new(WorkspaceFileEffectAdapter::new(
            self.scope.clone(),
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
