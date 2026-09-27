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
