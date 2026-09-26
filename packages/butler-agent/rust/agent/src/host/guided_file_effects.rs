//! Per-Turn preparation for registered workspace mutations through durable Effects.

mod edit;

use std::sync::Arc;

use serde_json::Value;

use crate::btcc::{BtccError, EffectAdapter, EffectJournal, WorkView, WorkspaceFileEffectAdapter};
use crate::capabilities::NativeCapabilities;
use crate::workspace::EffectFileScope;

use super::{NativeRegisteredEdit, NativeRegisteredWrite, RegisteredWriteContext};

pub(crate) struct PreparedGuidedFileEffect {
    pub target: String,
    pub input: Value,
    pub adapter: Arc<dyn EffectAdapter>,
}

pub(crate) struct NativeGuidedFileEffects {
    scope: EffectFileScope,
    registered_write: Arc<NativeRegisteredWrite>,
    registered_edit: Arc<NativeRegisteredEdit>,
}

impl NativeGuidedFileEffects {
    pub(crate) fn new(
        capabilities: Arc<NativeCapabilities>,
        context: RegisteredWriteContext,
        scope: EffectFileScope,
    ) -> Self {
        Self {
            scope,
            registered_edit: Arc::new(NativeRegisteredEdit::new(
                capabilities.clone(),
                context.clone(),
            )),
            registered_write: Arc::new(NativeRegisteredWrite::new(capabilities, context)),
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
            "write_file" => self.prepare_write(args),
            "edit_file" => edit::prepare(self, args, work, occurrence, journal).await,
            _ => Err(BtccError::relayed(
                "guided_file_effect_unbound",
                "Unsupported workspace file effect",
            )),
        }
    }

    pub(crate) fn prepare_write(
        &self,
        args: &Value,
    ) -> Result<PreparedGuidedFileEffect, BtccError> {
        let adapter: Arc<dyn EffectAdapter> = Arc::new(WorkspaceFileEffectAdapter::new(
            self.scope.clone(),
            self.registered_write.clone(),
        ));
        let input = adapter
            .normalize_input(args)
            .map_err(crate::btcc::BtccError::from)?;
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
