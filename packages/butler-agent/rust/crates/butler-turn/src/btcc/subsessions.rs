//! Shared BTCC subsession authority normalization.

pub(crate) mod assignment;
mod scope;
mod service;

#[cfg(test)]
pub(crate) use service::tests::delegation_identities_are_byte_stable;

pub(super) use scope::{SubsessionExecutionMode, SubsessionMetadata, read_subsession_metadata};
pub use service::{
    InterruptedSubsessionEvent, SessionControlRequest, StewardDelegationRequest,
    SubsessionCancelRequest, SubsessionChildQueue, SubsessionDirectionRequest, SubsessionEnqueue,
    SubsessionResumeRequest, SubsessionService, WorkerDelegationRequest, WorkerProfile,
    WorkerProfileReader,
};
