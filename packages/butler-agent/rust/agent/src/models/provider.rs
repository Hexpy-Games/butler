//! Physical provider request ownership and carrier dispatch.

mod continuation;
mod contracts;
mod native;
mod prompt;
mod redact;
mod result;
mod serialize;
mod visual;
mod visual_capability;

pub(crate) use contracts::{
    PromptCacheRetention, ProviderAuth, ProviderAuthMode, ProviderClock, ProviderConfigFuture,
    ProviderConfigRequest, ProviderObservation, ProviderObservationSink, ProviderPromptCachePolicy,
    ProviderRequestConfig, ProviderRequestConfigPort, ProviderRoundPolicy,
    ProviderVisualCapabilityFuture, ProviderVisualCapabilityPort,
};
pub(crate) use native::NativeModelProvider;

#[cfg(test)]
mod tests;
