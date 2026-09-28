//! Byte-level format pin of the KnowHow operator results and revised entry
//! files.
//!
//! The golden in `fixtures/format/operator.json` was generated from the
//! pre-typing `serde_json::Value` store. Run with `BUTLER_BLESS_FORMAT=1` to
//! regenerate it only when a format change is intended. Timestamps taken
//! from the clock read as `<now>`.

use std::{fs, path::Path, sync::Arc};

use serde_json::{Value, json};

use super::tests::{TestHost, entry, write_entry};
use super::{FeedbackResolveFuture, FeedbackResolvePort, KnowHowService};
use crate::cognition::{CognitionPathEnvironment, FeedbackTarget};
use crate::coordination::CognitionWriteCoordinator;

struct Resolved;

impl FeedbackResolvePort for Resolved {
    fn resolve_applied<'a>(&'a self, _: &'a str) -> FeedbackResolveFuture<'a> {
        Box::pin(async { Ok(()) })
    }
}

fn fixture(root: &Path) {
    let mut low = entry("kh_low_source", "2024-01-03T00:00:00.000Z");
    low["strategy"]["preferred_sources"] = json!(["weak-source"]);
    low["name"] = json!("weather lookup");
    let mut review = entry("kh_review", "2024-01-02T00:00:00.000Z");
    review["strategy"]["preferred_sources"] = json!(["middling-source"]);
    review["intent_match"]["topics"] = json!(["deploy pipeline"]);
    let mut feedback = entry("kh_feedback", "2024-01-01T00:00:00.000Z");
    feedback["status"] = json!("candidate");
    let mut disabled = entry("kh_disabled", "2023-12-31T00:00:00.000Z");
    disabled["status"] = json!("disabled");
    for value in [&low, &review, &feedback, &disabled] {
        write_entry(root, value);
    }
    fs::write(
        root.join("cognition/know-how/source-quality.jsonl"),
        concat!(
            "{\"source_id\":\"weak-source\",\"tool_name\":\"search\",\"observed_at\":\"2024-01-01T00:00:00.000Z\",\"freshness_score\":0.1,\"success\":false,\"latency_ms\":900,\"user_feedback\":\"negative\"}\n",
            "{\"source_id\":\"middling-source\",\"tool_name\":\"fetch\",\"observed_at\":\"2024-01-02T00:00:00.000Z\",\"freshness_score\":0.5,\"success\":true,\"latency_ms\":300,\"user_feedback\":\"none\"}\n",
            "{\"source_id\":\"middling-source\",\"tool_name\":\"fetch\",\"observed_at\":\"2024-01-03T00:00:00.000Z\",\"freshness_score\":0.4,\"success\":false,\"latency_ms\":500,\"user_feedback\":\"none\"}\n",
            "{\"source_id\":\"shared-source\",\"tool_name\":\"search\",\"observed_at\":\"2024-01-04T00:00:00.000Z\",\"freshness_score\":1.0,\"success\":true,\"latency_ms\":10,\"user_feedback\":\"none\"}\n",
        ),
    )
    .unwrap();
}

fn entry_files(root: &Path) -> Value {
    let directory = root.join("cognition/know-how/entries");
    let mut names = fs::read_dir(&directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    names.sort();
    Value::Object(
        names
            .into_iter()
            .map(|name| {
                let text = fs::read_to_string(directory.join(&name)).unwrap();
                (name, Value::String(text))
            })
            .collect(),
    )
}

#[tokio::test]
async fn operator_results_and_revised_entries_keep_their_bytes() {
    let root = std::env::temp_dir().join(format!("butler-knowhow-pin-{}", uuid::Uuid::new_v4()));
    fixture(&root);
    let coordinator = CognitionWriteCoordinator::new(Arc::new(TestHost)).unwrap();
    let service = KnowHowService::new(
        root.clone(),
        CognitionPathEnvironment::default(),
        Arc::new(coordinator),
    );
    let feedback = [
        FeedbackTarget {
            feedback_id: "fb_entry".into(),
            category: "answer_quality".into(),
            promotion_target: "knowhow".into(),
            target_ref: "knowhow:kh_feedback".into(),
        },
        FeedbackTarget {
            feedback_id: "fb_policy".into(),
            category: "source_policy".into(),
            promotion_target: "memory".into(),
            target_ref: "source:shared-source".into(),
        },
    ];
    let rebuild = service.operator_rebuild_index().await.unwrap();
    let retrieve = service
        .operator_retrieve("how do I run the deploy pipeline helper", 3, &feedback)
        .await
        .unwrap();
    let quality = service.operator_source_quality().await.unwrap();
    let list = service.operator_entries().await.unwrap();
    let shown = service.operator_read("kh_review").await.unwrap();
    let missing = service.operator_read("kh_missing").await.unwrap();
    let revised = service.revise(&feedback, &Resolved).await.unwrap();
    let disabled = service.operator_disable("kh_review").await.unwrap();
    let pinned = json!({
        "rebuild": {
            "indexed_count": rebuild["indexed_count"],
            "source_quality_count": rebuild["source_quality_count"],
        },
        "retrieve": retrieve,
        "quality": quality,
        "list": list,
        "shown": shown,
        "missing": missing,
        "revised": [
            revised.revised_knowhow_count,
            revised.demoted_knowhow_count,
            revised.applied_feedback_count,
        ],
        "disabled": disabled,
        "files": entry_files(&root),
    });
    let _ = fs::remove_dir_all(&root);
    let text = butler_core::json::pretty(&pinned);
    let text = regex::Regex::new(r"20(2[5-9]|[3-9]\d)-\d\d-\d\dT\d\d:\d\d:\d\d\.\d\d\dZ")
        .unwrap()
        .replace_all(&text, "<now>")
        .into_owned();
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src/cognition/knowhow_store/fixtures/format/operator.json");
    if std::env::var_os("BUTLER_BLESS_FORMAT").is_some() {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, &text).unwrap();
        return;
    }
    let expected = fs::read_to_string(&path).unwrap();
    assert_eq!(text, expected, "knowhow format changed");
}
