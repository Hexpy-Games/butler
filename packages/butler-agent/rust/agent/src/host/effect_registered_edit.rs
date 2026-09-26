//! Registered edit_file invocation; BTCC owns identity and dispatch admission.

use std::sync::Arc;

use serde_json::{Value, json};

use crate::btcc::{EffectFailure, EffectFuture, RegisteredEditPort};
use crate::capabilities::{CapabilityInvocation, NativeCapabilities};

use super::RegisteredWriteContext;

pub(crate) struct NativeRegisteredEdit {
    capabilities: Arc<NativeCapabilities>,
    context: RegisteredWriteContext,
}
impl NativeRegisteredEdit {
    pub(crate) fn new(
        capabilities: Arc<NativeCapabilities>,
        context: RegisteredWriteContext,
    ) -> Self {
        Self {
            capabilities,
            context,
        }
    }
}
impl RegisteredEditPort for NativeRegisteredEdit {
    fn edit(&self, prepared: Value) -> EffectFuture<'_, Value> {
        Box::pin(async move {
            let call = json!({"arguments":prepared});
            self.capabilities
                .invoke(
                    "edit_file",
                    CapabilityInvocation {
                        call: &call,
                        workspace_reference: self.context.workspace_reference.as_ref(),
                        workspace_path: Some(&self.context.workspace_path),
                        butler_data: &self.context.butler_data,
                        protected_ledger_roots: &self.context.protected_ledger_roots,
                        allowed_tools_and_effects: self
                            .context
                            .allowed_tools_and_effects
                            .as_deref(),
                        mutation_scope: self.context.mutation_scope.as_deref(),
                        installation_root: self.context.installation_root.as_deref(),
                    },
                )
                .await
                .map_err(|error| EffectFailure::adapter(error.code))
        })
    }
}
