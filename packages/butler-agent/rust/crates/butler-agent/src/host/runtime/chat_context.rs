//! Chat context services share one resolved model budget and completion lane.
use super::{ConversationObserver, RuntimePaths, models::ProcessModels, stores::RuntimeStores};
use crate::host::memory_jobs::continuity::{Continuity, Owners};
use butler_memory::{cognition::CognitionPathEnvironment, profile::ProfileService};
use butler_runtime::{
    context::{ContextBudgetEnvironment, ContextBudgetOwner, ContextConversation, ToolOutput},
    operations::MetricFiles,
};
use std::sync::Arc;

pub(super) async fn open(
    paths: &RuntimePaths,
    (budget_environment, cognition_paths): (&ContextBudgetEnvironment, &CognitionPathEnvironment),
    models: &ProcessModels,
    stores: &RuntimeStores,
    profile: Arc<ProfileService>,
    observer: &ConversationObserver,
    metrics: Arc<MetricFiles>,
) -> (
    Arc<ContextBudgetOwner>,
    Arc<Continuity>,
    ToolOutput,
    ContextConversation,
) {
    let budget = Arc::new(ContextBudgetOwner::new(
        models.configuration.clone(),
        models.catalog.clone(),
        budget_environment.clone(),
    ));
    let continuity = Continuity::new(Owners {
        memory_root: cognition_paths.memory_root(&paths.data_root),
        data_root: paths.data_root.clone(),
        conversations: stores.conversations.clone(),
        bindings: stores.bindings.clone(),
        budget: budget.clone(),
        profile,
        provider: models.provider.clone(),
    });
    observer.set_continuity(continuity.clone()).await;
    let output = crate::host::open_tool_output(paths.data_root.clone(), budget.clone(), metrics);
    let conversation = ContextConversation::new(
        stores.conversations.clone(),
        models.configuration.clone(),
        models.catalog.clone(),
        budget_environment.clone(),
    );
    (budget, continuity, output, conversation)
}
