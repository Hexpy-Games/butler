//! Physical provider request ownership and carrier dispatch.

mod continuation;
mod contracts;
mod keepalive;
mod local_stream;
mod output_image;
mod prefix_diagnostics;
mod prompt;
mod redact;
pub(super) mod request_trace;
mod result;
mod round_usage;
mod route;
mod serialize;
mod sizing;
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
