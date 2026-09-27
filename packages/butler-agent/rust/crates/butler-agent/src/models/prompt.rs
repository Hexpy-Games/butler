//! Crate-private prompt inference contracts shared by native consumers.

mod contracts;

pub(crate) use contracts::{
    PromptAdapterEntry, PromptCallbackFuture, PromptInvocationIntent, PromptJsonSchema,
    PromptUsageAttribution, PromptUsageBudgetState, PromptUsageMetricInput, PromptUsageMetricSink,
    PromptUsageReport, PromptUsageSectionAttribution, ProviderPromptFuture,
    ProviderPromptLifecycle, ProviderPromptPort, ProviderPromptRequest, ProviderPromptResult,
};
#[cfg(test)]
pub(crate) use contracts::{PromptBudgetStateSource, PromptCacheBoundary};
