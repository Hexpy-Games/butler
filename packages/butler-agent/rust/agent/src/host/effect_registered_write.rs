//! Concrete registered write_file call for the reviewed Effects adapter.

use std::{path::PathBuf, sync::Arc};

use serde_json::{Value, json};

use crate::btcc::{EffectFailure, EffectFuture, PreparedWrite, RegisteredWritePort};
use crate::capabilities::{CapabilityInvocation, NativeCapabilities};
use crate::workspace::WorkspaceReference;

#[derive(Clone)]
pub(crate) struct RegisteredWriteContext {
    pub workspace_reference: Option<WorkspaceReference>,
    pub workspace_path: PathBuf,
    pub butler_data: PathBuf,
    pub protected_ledger_roots: Vec<PathBuf>,
    pub allowed_tools_and_effects: Option<Vec<String>>,
    pub mutation_scope: Option<Vec<String>>,
    pub installation_root: Option<PathBuf>,
}

pub(crate) struct NativeRegisteredWrite {
    capabilities: Arc<NativeCapabilities>,
    context: RegisteredWriteContext,
}
impl NativeRegisteredWrite {
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

impl RegisteredWritePort for NativeRegisteredWrite {
    fn write<'a>(&'a self, prepared: PreparedWrite) -> EffectFuture<'a, Value> {
        Box::pin(async move {
            let mut arguments = json!({
                "path":prepared.path,"content":prepared.content,
                "create_parents":prepared.create_parents,"overwrite":prepared.overwrite
            });
            if let Some(expected) = prepared.expected_sha256 {
                arguments["expected_sha256"] = json!(expected);
            }
            let call = json!({"arguments":arguments});
            self.capabilities
                .invoke(
                    "write_file",
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
