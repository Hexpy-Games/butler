//! Byte-level format pin of an extractor run: the prompts sent to the
//! provider (meaning, binding and a binding repair), the stage keys and saved
//! stage results, the run evidence and the output with its pinned input.
//!
//! The golden in `fixtures/format/extractor-run.json` was generated from the
//! pre-typing `serde_json::Value` extractor. Run with `BUTLER_BLESS_FORMAT=1`
//! to regenerate it only when a format change is intended.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

use butler_models::models::{
    PromptUsageReport, ProviderPromptFuture, ProviderPromptLifecycle, ProviderPromptPort,
    ProviderPromptRequest, ProviderPromptResult,
};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::{
    CandidateSearchFuture, CandidateSearchInput, CognitionCandidateSearch, ExtractCandidate,
    ExtractInput, ExtractOutput, ExtractionRunInput, ExtractionStagePort, StageFuture,
    run_extractor,
};
use crate::cognition::graph::ExtractionStageResult;

/// Answers each stage from a script and records every prompt it was sent.
#[derive(Default)]
struct ScriptedProvider {
    prompts: Mutex<Vec<String>>,
}

impl ProviderPromptPort for ScriptedProvider {
    fn run_prompt<'a>(
        &'a self,
        request: ProviderPromptRequest<'a>,
        lifecycle: ProviderPromptLifecycle<'a>,
    ) -> ProviderPromptFuture<'a> {
        Box::pin(async move {
            if let Some(intent) = lifecycle.invocation_intent {
                intent.invoked().await?;
            }
            if let Some(entry) = lifecycle.adapter_entry {
                entry.entered()?;
            }
            self.prompts.lock().unwrap().push(request.prompt.to_owned());
            let name = request.response_format.as_ref().unwrap().name;
            let answer = match name {
                "memory_meaning_v4" => meaning_answer(),
                _ if request.prompt.contains("\"correction\"") => json!({"decisions":[
                    {"target":"n0","candidate":"n0c0","span":null,
                     "current_support":["n0u0"],"selected_historical_support":["n0c0h"]},
                    {"target":"f5","candidate":"f5c0","span":"f5c0p0",
                     "current_support":["f5u1"],"selected_historical_support":["f5c0h"]}]}),
                _ => json!({"decisions":[]}),
            };
            Ok(ProviderPromptResult {
                text: answer.to_string(),
                model: "provider/reported".into(),
                usage: Some(PromptUsageReport {
                    model: "provider/reported".into(),
                    prompt_tokens: Some(100.0),
                    cached_tokens: 20.0,
                    total_tokens: Some(130.0),
                    output_tokens: 30.0,
                }),
            })
        })
    }
}

/// Every kind of item and attribute, with keys in the contract's order.
fn meaning_answer() -> Value {
    json!({"status":"processed",
        "entities":[{"name":"Alice","evidence":[0]},{"name":"Atlas","evidence":[0,1]}],
        "items":[
            {"kind":"preference","subject":0,"text":"Alice prefers mornings","evidence":[0]},
            {"kind":"relation","from":0,"predicate":"likes","to":1,"evidence":[0]},
            {"kind":"not_relation","from":1,"predicate":"depends_on","to":0,"evidence":[1]},
            {"kind":"requires","subject":0,"action":"ship Atlas","condition":{"all":[
                {"subject":1,"state":"ready"},{"not":{"subject":null,"state":"a holiday"}},
                {"any":[{"subject":0,"state":"awake"}]}]},"evidence":[0,1]},
            {"kind":"question","subject":null,"text":"Is Atlas late?","evidence":[1]},
            {"kind":"change","subject":1,"field":"deadline","old":"2026","new":"2027","evidence":[1]}],
        "attributes":[
            {"kind":"alias","entity":0,"name":"Al","evidence":[0]},
            {"kind":"importance","item":3,"value":"high"},
            {"kind":"validity","item":0,"from":"2026-01-01","to":null}]})
}

/// One identity candidate for Alice and one past claim for the deadline.
struct Candidates;

impl CognitionCandidateSearch for Candidates {
    fn search<'a>(&'a self, input: CandidateSearchInput<'a>) -> CandidateSearchFuture<'a> {
        let found = if input.cue == "Alice" {
            vec![candidate(
                json!({"ref":"node-alice","type":"entity","label":"Alice",
                "aliases":["Al"],"scope":"user","project_id":null,
                "evidence":[{"ref":"src-1","text":"Alice said hi. Then left.",
                    "observed_at":"2026-01-01T00:00:00.000Z","basis":"user_statement"}]}),
            )]
        } else if input.cue.contains("deadline") {
            vec![candidate(
                json!({"ref":"claim-deadline","type":"memory_atom",
                "label":"deadline 2026","aliases":[],"scope":"user","project_id":null,
                "claim":{"statement":"Atlas deadline 2026 is firm","subject_ref":null,
                    "object_ref":null,"relation":null,"polarity":"positive","condition":null},
                "evidence":[{"ref":"src-2","text":"The deadline 2026 is firm.",
                    "observed_at":"2026-01-02T00:00:00.000Z","basis":"user_statement"}]}),
            )]
        } else {
            Vec::new()
        };
        Box::pin(async move { Ok(found) })
    }
}

fn candidate(value: Value) -> ExtractCandidate {
    serde_json::from_value(value).unwrap()
}

/// Keeps saved stage results in memory, as the window would.
#[derive(Default)]
struct Stages {
    saved: Mutex<BTreeMap<String, ExtractionStageResult>>,
    order: Mutex<Vec<String>>,
}

impl ExtractionStagePort for Stages {
    fn load<'a>(&'a self, key: &'a str) -> StageFuture<'a, Option<ExtractionStageResult>> {
        Box::pin(async move { Ok(self.saved.lock().unwrap().get(key).cloned()) })
    }
    fn save<'a>(&'a self, key: &'a str, result: ExtractionStageResult) -> StageFuture<'a, ()> {
        Box::pin(async move {
            self.order.lock().unwrap().push(key.to_owned());
            self.saved.lock().unwrap().insert(key.to_owned(), result);
            Ok(())
        })
    }
    fn commit_meaning<'a>(
        &'a self,
        _: &'a ExtractInput,
        _: &'a ExtractOutput,
    ) -> StageFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }
    fn invocation_intent<'a>(&'a self, _: &'a ExtractInput) -> StageFuture<'a, ()> {
        Box::pin(async { Ok(()) })
    }
    fn adapter_entry(&self) -> crate::cognition::CognitionResult<()> {
        Ok(())
    }
}

fn input() -> ExtractInput {
    serde_json::from_value(json!({"schema":"butler.memory-extract-input.v2",
        "episode_ref":"episode","revision":"revision-1","window_ref":"window-1",
        "bound_project_id":null,
        "source_units":[{"ref":"unit-1","text":"Alice likes Atlas. The Atlas deadline moved from 2026 to 2027.",
            "role":"user","observed_at":"2026-02-01T00:00:00.000Z","origin_kind":"user_input"}],
        "context_units":[{"ref":"ctx-1","text":"Earlier we planned Atlas.",
            "observed_at":"2026-01-31T00:00:00.000Z","basis":"user_statement"}],
        "candidates":[]}))
    .unwrap()
}

#[tokio::test]
async fn extractor_run_prompts_keys_evidence_and_output_keep_their_bytes() {
    let provider = ScriptedProvider::default();
    let stages = Stages::default();
    let run = run_extractor(ExtractionRunInput {
        provider: &provider,
        candidates: &Candidates,
        input: input(),
        model: "test/model",
        effort: "low",
        butler_data: "/nonexistent/butler",
        generation: "generation-1",
        embedding: None,
        stages: &stages,
        cancellation: CancellationToken::new(),
        deadline: 0,
    })
    .await
    .unwrap();
    let pinned = json!({
        "prompts": *provider.prompts.lock().unwrap(),
        "stage_keys": *stages.order.lock().unwrap(),
        "saved": serde_json::to_value(&*stages.saved.lock().unwrap()).unwrap(),
        "evidence": serde_json::to_value(&run.evidence).unwrap(),
        "output": serde_json::to_value(&run.output).unwrap(),
        "pinned_input": serde_json::to_value(&run.pinned_input).unwrap(),
    });
    let text = butler_core::json::pretty(&pinned);
    let text = regex::Regex::new(r#""duration_ms": \d+"#)
        .unwrap()
        .replace_all(&text, r#""duration_ms": 0"#)
        .into_owned();
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src/cognition/extraction/fixtures/format/extractor-run.json");
    if std::env::var_os("BUTLER_BLESS_FORMAT").is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &text).unwrap();
        return;
    }
    let expected = std::fs::read_to_string(&path).unwrap();
    assert_eq!(text, expected, "extractor run format changed");
}
