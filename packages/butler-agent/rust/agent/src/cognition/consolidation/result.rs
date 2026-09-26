use std::path::Path;

use serde_json::{Map, Value};

use crate::cognition::{CognitionPathEnvironment, CognitionResult};

use super::{
    checkpoint,
    types::{
        CycleResult, CycleStatus, ModelUsageSummary, PhaseResult, PhaseUsageSummary,
        USAGE_RATE_SOURCE, UsageReport,
    },
};

const CODEX_GPT_5_5_CREDITS_PER_MILLION: (f64, f64, f64) = (125.0, 12.5, 750.0);
const API_GPT_5_5_USD_PER_MILLION: (f64, f64, f64) = (5.0, 0.5, 30.0);

pub(crate) fn build_result(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    run_id: String,
    started_at: String,
    status: CycleStatus,
    phases: Vec<PhaseResult>,
    completed_at: Option<String>,
) -> CognitionResult<CycleResult> {
    let checkpoint_path = checkpoint::checkpoint_path(data_root, environment, &run_id)?;
    let summary_path = checkpoint::summary_path(data_root, environment, &run_id)?;
    let usage = build_usage_report(&phases);
    Ok(CycleResult {
        run_id,
        status,
        started_at,
        completed_at,
        phases,
        checkpoint_path: checkpoint_path.to_string_lossy().into_owned(),
        summary_path: summary_path.to_string_lossy().into_owned(),
        usage,
        raw_text_included: false,
    })
}

pub(crate) fn write_summary(
    data_root: &Path,
    environment: &CognitionPathEnvironment,
    result: &CycleResult,
) -> CognitionResult<()> {
    let path = checkpoint::summary_path(data_root, environment, &result.run_id)?;
    checkpoint::write_atomic(&path, result)
}

pub(crate) fn build_usage_report(phases: &[PhaseResult]) -> UsageReport {
    let mut total = ModelUsageSummary::empty();
    let mut phase_summaries = Vec::with_capacity(phases.len());
    for phase in phases {
        let usage = model_usage_from_value(phase.metrics.get("model_usage"))
            .unwrap_or_else(ModelUsageSummary::empty);
        total = merge_usage(&total, &usage);
        phase_summaries.push(PhaseUsageSummary {
            phase: phase.phase,
            usage,
        });
    }
    UsageReport {
        usage: total,
        phases: phase_summaries,
    }
}

fn model_usage_from_value(value: Option<&Value>) -> Option<ModelUsageSummary> {
    let input = value?.as_object()?;
    let request_count = finite_number(input, "request_count")?;
    let prompt_tokens = finite_number(input, "prompt_tokens")?;
    let cached_input_tokens = finite_number(input, "cached_input_tokens")?;
    let uncached_input_tokens = finite_number(input, "uncached_input_tokens")?;
    let output_tokens = finite_number(input, "output_tokens")?;
    let total_tokens = finite_number(input, "total_tokens")?;
    let mut models = input
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|model| !model.trim().is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>();
    models.sort();
    models.dedup();
    Some(finalize_usage(
        request_count,
        prompt_tokens,
        cached_input_tokens,
        uncached_input_tokens,
        output_tokens,
        total_tokens,
        models,
    ))
}

fn finite_number(input: &Map<String, Value>, key: &str) -> Option<f64> {
    input
        .get(key)?
        .as_f64()
        .filter(|value| value.is_finite() && *value >= 0.0)
}

fn merge_usage(left: &ModelUsageSummary, right: &ModelUsageSummary) -> ModelUsageSummary {
    let mut models = left
        .models
        .iter()
        .chain(&right.models)
        .cloned()
        .collect::<Vec<_>>();
    models.sort();
    models.dedup();
    finalize_usage(
        safe_sum(left.request_count, right.request_count),
        safe_sum(left.prompt_tokens, right.prompt_tokens),
        safe_sum(left.cached_input_tokens, right.cached_input_tokens),
        safe_sum(left.uncached_input_tokens, right.uncached_input_tokens),
        safe_sum(left.output_tokens, right.output_tokens),
        safe_sum(left.total_tokens, right.total_tokens),
        models,
    )
}

fn safe_sum(left: f64, right: f64) -> f64 {
    let total = left + right;
    if total.is_finite() { total } else { f64::MAX }
}

fn finalize_usage(
    request_count: f64,
    prompt_tokens: f64,
    cached_input_tokens: f64,
    uncached_input_tokens: f64,
    output_tokens: f64,
    total_tokens: f64,
    models: Vec<String>,
) -> ModelUsageSummary {
    let codex_rates = CODEX_GPT_5_5_CREDITS_PER_MILLION;
    let api_rates = API_GPT_5_5_USD_PER_MILLION;
    let credits = uncached_input_tokens / 1_000_000.0 * codex_rates.0
        + cached_input_tokens / 1_000_000.0 * codex_rates.1
        + output_tokens / 1_000_000.0 * codex_rates.2;
    let api_usd = uncached_input_tokens / 1_000_000.0 * api_rates.0
        + cached_input_tokens / 1_000_000.0 * api_rates.1
        + output_tokens / 1_000_000.0 * api_rates.2;
    ModelUsageSummary {
        request_count,
        prompt_tokens,
        cached_input_tokens,
        uncached_input_tokens,
        output_tokens,
        total_tokens,
        models,
        estimated_codex_5_5_credits: round_cost(credits),
        estimated_api_gpt_5_5_usd: round_cost(api_usd),
        rate_source: USAGE_RATE_SOURCE.into(),
        raw_text_included: false,
    }
}

fn round_cost(value: f64) -> f64 {
    if value.abs() <= f64::MAX / 1_000_000.0 {
        (value * 1_000_000.0).round() / 1_000_000.0
    } else {
        value
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use serde_json::{Value, json};

    use super::*;
    use crate::cognition::consolidation::types::{Phase, PhaseResultStatus};

    fn root() -> PathBuf {
        std::env::temp_dir().join(format!(
            "butler-consolidation-result-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ))
    }

    fn phase(phase: Phase, model: &str) -> PhaseResult {
        let mut result = PhaseResult::new(phase, PhaseResultStatus::Ok);
        result.metrics.insert(
            "model_usage".into(),
            json!({
                "request_count":1,
                "prompt_tokens":10,
                "cached_input_tokens":2,
                "uncached_input_tokens":8,
                "output_tokens":5,
                "total_tokens":15,
                "models":[model]
            }),
        );
        result
    }

    #[test]
    fn result_reduces_safe_usage_and_writes_summary_to_runs() {
        let root = root();
        let environment = CognitionPathEnvironment::default();
        let result = build_result(
            &root,
            &environment,
            "cr_result".into(),
            "2026-09-23T00:00:00.000Z".into(),
            CycleStatus::Completed,
            vec![
                phase(Phase::Preflight, "zeta"),
                phase(Phase::BoxIndex, "alpha"),
            ],
            Some("2026-09-23T00:01:00.000Z".into()),
        )
        .unwrap();

        assert_eq!(result.usage.usage.request_count, 2.0);
        assert_eq!(result.usage.usage.prompt_tokens, 20.0);
        assert_eq!(
            result.usage.usage.models,
            vec!["alpha".to_owned(), "zeta".to_owned()]
        );
        assert_eq!(result.usage.phases.len(), 2);
        assert_eq!(result.usage.usage.rate_source, USAGE_RATE_SOURCE);
        assert!(!result.raw_text_included);
        assert!(!result.usage.usage.raw_text_included);
        write_summary(&root, &environment, &result).unwrap();
        let summary: Value = serde_json::from_slice(
            &fs::read(root.join("cognition/consolidation/runs/cr_result.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(summary["raw_text_included"], false);
        assert_eq!(summary["usage"]["request_count"], 2.0);
        assert!(Path::new(&result.checkpoint_path).ends_with("checkpoints/cr_result.json"));
        assert!(Path::new(&result.summary_path).ends_with("runs/cr_result.json"));
        let _ = fs::remove_dir_all(root);
    }
}
