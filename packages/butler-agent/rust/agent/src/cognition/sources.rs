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

pub(crate) use context::read_prior_public_context;
pub(crate) use hydration::hydrate_conversation_source;
pub(in crate::cognition) use identity::projection_hash as projection_hash_for_graph;
pub(in crate::cognition) use inventory::{CanonicalInventory, read_canonical_inventory};
pub(in crate::cognition) use planner::assert_conversation_source_current;
pub(crate) use planner::prepare_conversation_source;
pub(in crate::cognition) use recall::{
    RecallSourceHydration, RecallSourceResolution, hydrate_recall_sources, identity_binding_current,
};
pub(crate) use typed::{
    ExplicitMemoryUpdateInput, ExplicitMemoryUpdateResult, TaskMemoryIngestionResult,
    ingest_task_outcome_memory, update_explicit_memory,
};
pub(in crate::cognition) use typed::{
    TypedMemoryLifecycle, TypedMemoryRecord, hydrate_typed_source, read_explicit_record,
    read_task_report, read_typed_memory_lifecycle, read_typed_record,
};
pub(in crate::cognition) use typed_plan::{TypedPlan, prepare as prepare_typed_source};
pub(crate) use types::{
    CognitionSourceError, CognitionSourcePlan, CognitionSourceRow, ConversationSourceNotice,
    PreparedConversationSource,
};

#[cfg(test)]
pub(super) mod tests;
