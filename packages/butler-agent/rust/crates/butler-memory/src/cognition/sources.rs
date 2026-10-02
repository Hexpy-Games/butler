//! Canonical Conversation source preparation before graph registration.

mod context;
mod hydration;
mod identity;
mod inventory;
mod planner;
mod recall;
mod typed;
mod typed_plan;
mod types;

pub use context::read_prior_public_context;
pub use hydration::hydrate_conversation_source;
pub(in crate::cognition) use identity::projection_hash as projection_hash_for_graph;
pub(in crate::cognition) use inventory::{CanonicalInventory, read_canonical_inventory};
pub(in crate::cognition) use planner::assert_conversation_source_current;
pub use planner::prepare_conversation_source;
pub(in crate::cognition) use recall::{
    RecallSourceHydration, RecallSourceResolution, ResolvedRecallSource, hydrate_recall_sources,
    identity_binding_current,
};
pub use typed::{
    ExplicitMemoryUpdateInput, RememberedRule, RememberedRuleOwner, RememberedRuleReceipt,
    RememberedRuleTarget, RuleCommitObserver, TaskMemoryIngestionResult,
    ingest_task_outcome_memory, list_remembered_rules,
};
pub(in crate::cognition) use typed::{
    TypedMemoryLifecycle, TypedMemoryRecord, hydrate_typed_source, read_explicit_record,
    read_task_report, read_typed_memory_lifecycle, read_typed_record,
};
pub(in crate::cognition) use typed_plan::{TypedPlan, TypedSpan, prepare as prepare_typed_source};
pub use types::{
    CognitionSourcePlan, CognitionSourceRow, ConversationSourceNotice, PreparedConversationSource,
};

#[cfg(test)]
pub(super) mod tests;
