//! Physical provider request ownership and carrier dispatch.

mod continuation;
mod contracts;
mod local_stream;
mod prompt;
mod redact;
mod result;
mod round_usage;
mod route;
mod serialize;
mod visual;
mod visual_capability;

pub use crate::models::provider::client::ModelProvider;
pub use contracts::{
    PromptCacheRetention, ProviderAuth, ProviderAuthMode, ProviderClock, ProviderConfigFuture,
    ProviderConfigRequest, ProviderObservation, ProviderObservationSink, ProviderPromptCachePolicy,
    ProviderRequestConfig, ProviderRequestConfigPort, ProviderRoundPolicy,
    ProviderVisualCapabilityFuture, ProviderVisualCapabilityPort,
};

mod client;
#[cfg(test)]
mod tests;
