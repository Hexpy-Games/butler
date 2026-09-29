//! Crate-private prompt inference contracts shared by native consumers.

mod contracts;

pub use contracts::{
    PromptAdapterEntry, PromptCallbackFuture, PromptInvocationIntent, PromptJsonSchema,
    PromptUsageAttribution, PromptUsageBudgetState, PromptUsageMetricInput, PromptUsageMetricSink,
    PromptUsageReport, PromptUsageSectionAttribution, ProviderPromptFuture,
    ProviderPromptLifecycle, ProviderPromptPort, ProviderPromptRequest, ProviderPromptResult,
};
pub use contracts::{PromptBudgetStateSource, PromptCacheBoundary, UsageAuthMode};
