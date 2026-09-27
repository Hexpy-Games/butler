mod format;
mod parts;
mod read;
mod types;

pub(crate) use format::compile_prompt_material_context_plan;
pub(in crate::context) use parts::{to_context_message, to_context_summary};
pub(in crate::context) use read::apply_char_budget;
pub(crate) use read::{canonical_conversation_session_id, read_conversation_context};
pub(crate) use types::*;

use std::sync::Arc;

use crate::conversation::AgentConversationStore;
use crate::models::{ModelCatalog, ModelConfiguration};

use super::{ContextBudgetEnvironment, ContextBudgetOwner};

#[derive(Clone)]
pub(crate) struct ContextConversation {
    store: AgentConversationStore,
    budget: Arc<ContextBudgetOwner>,
}

impl ContextConversation {
    pub(crate) fn new(
        store: AgentConversationStore,
        configuration: Arc<ModelConfiguration>,
        catalog: Arc<ModelCatalog>,
        environment: ContextBudgetEnvironment,
    ) -> Self {
        Self {
            store,
            budget: Arc::new(ContextBudgetOwner::new(configuration, catalog, environment)),
        }
    }

    pub(crate) fn store(&self) -> &AgentConversationStore {
        &self.store
    }
    pub(crate) fn budget(&self) -> &ContextBudgetOwner {
        &self.budget
    }

    pub(crate) async fn read_conversation_context(
        &self,
        input: ReadConversationContextInput,
    ) -> super::ContextResult<ConversationContextResult> {
        read_conversation_context(&self.store, input).await
    }
}
