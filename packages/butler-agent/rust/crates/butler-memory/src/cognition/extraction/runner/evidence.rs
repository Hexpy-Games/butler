//! Provider evidence of extraction stages: what each call reported (saved
//! with the stage result and replayed with it) and the run-level summary
//! stored as `provider_evidence_json`.

use serde::{Deserialize, Serialize};

use crate::cognition::extraction::binding::BindingWarning;

/// What one provider call reported.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(in crate::cognition) struct ProviderEvidence {
    pub reported_model: String,
    pub usage: Option<StageUsage>,
    pub duration_ms: u64,
    pub request_wire: RequestWire,
}

/// Token usage of one provider call.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(in crate::cognition) struct StageUsage {
    pub prompt_tokens: Option<f64>,
    pub cached_tokens: f64,
    pub output_tokens: f64,
    pub total_tokens: Option<f64>,
}

/// Digests of the request a stage sent; part of the stage's request hash.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub(in crate::cognition) struct RequestWire {
    pub profile: String,
    pub input_json_sha256: String,
    pub input_json_utf8_bytes: usize,
    pub instructions_sha256: String,
    pub output_schema_sha256: String,
}

/// One stage attempt of a run (a first call or a repair).
#[derive(Clone, Debug, Serialize)]
pub(in crate::cognition) struct StageEvidence {
    pub stage: String,
    pub repair: usize,
    pub reused: bool,
    pub request_hash: String,
    pub provider: ProviderEvidence,
}

/// Evidence of a whole extraction run: the first stage's model and wire,
/// usage summed over the calls made (not replayed), every stage attempt and
/// the binding warnings.
#[derive(Clone, Debug, Serialize)]
pub(in crate::cognition) struct RunEvidence {
    pub reported_model: Option<String>,
    pub usage: Option<UsageTotals>,
    pub duration_ms: u64,
    pub request_wire: Option<RequestWire>,
    pub stages: Vec<StageEvidence>,
    pub warnings: Vec<BindingWarning>,
}

/// Token usage summed over the calls of a run.
#[derive(Clone, Debug, Serialize)]
pub(in crate::cognition) struct UsageTotals {
    pub prompt_tokens: f64,
    pub cached_tokens: f64,
    pub output_tokens: f64,
    pub total_tokens: f64,
}

impl RunEvidence {
    pub(super) fn new(
        stages: Vec<StageEvidence>,
        warnings: Vec<BindingWarning>,
        duration_ms: u64,
    ) -> Self {
        let first = stages.first().map(|stage| &stage.provider);
        Self {
            reported_model: first.map(|provider| provider.reported_model.clone()),
            usage: aggregate_usage(&stages),
            duration_ms,
            request_wire: first.map(|provider| provider.request_wire.clone()),
            stages,
            warnings,
        }
    }
}

/// Usage summed over the stages that called the provider; `None` when any
/// of them reported no usage.
fn aggregate_usage(stages: &[StageEvidence]) -> Option<UsageTotals> {
    let called = stages
        .iter()
        .filter(|stage| !stage.reused)
        .map(|stage| stage.provider.usage.as_ref())
        .collect::<Option<Vec<_>>>()?;
    let sum = |value: fn(&StageUsage) -> Option<f64>| called.iter().filter_map(|u| value(u)).sum();
    Some(UsageTotals {
        prompt_tokens: sum(|u| u.prompt_tokens),
        cached_tokens: sum(|u| Some(u.cached_tokens)),
        output_tokens: sum(|u| Some(u.output_tokens)),
        total_tokens: sum(|u| u.total_tokens),
    })
}
