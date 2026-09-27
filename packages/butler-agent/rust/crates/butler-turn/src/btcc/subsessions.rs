//! Shared BTCC subsession authority normalization.

mod scope;
mod service;

pub(super) use scope::{SubsessionExecutionMode, SubsessionMetadata, read_subsession_metadata};
pub use service::{
    InterruptedSubsessionEvent, StewardDelegationRequest, SubsessionCancelRequest,
    SubsessionChildQueue, SubsessionDirectionRequest, SubsessionEnqueue, SubsessionResumeRequest,
    SubsessionService, WorkerDelegationRequest, WorkerProfile, WorkerProfileReader,
};
