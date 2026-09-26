//! Shared BTCC subsession authority normalization.

mod scope;
mod service;

pub(super) use scope::{SubsessionExecutionMode, SubsessionMetadata, read_subsession_metadata};
pub(crate) use service::{
    InterruptedSubsessionEvent, NativeSubsessionService, StewardDelegationRequest,
    SubsessionCancelRequest, SubsessionChildQueue, SubsessionDirectionRequest, SubsessionEnqueue,
    SubsessionResumeRequest, WorkerDelegationRequest, WorkerProfile, WorkerProfileReader,
};
