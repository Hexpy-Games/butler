use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use rusqlite::{Connection, OpenFlags};
use serde_json::{Value, json};

use crate::{
    cognition::{CognitionError, CognitionPathEnvironment, FeedbackTarget},
    coordination::{
        CognitionCoordinationHost, CognitionProcessStatus, CognitionWriteAcquire,
        CognitionWriteCoordinator, CoordinationResult,
    },
};

use super::{FeedbackResolveFuture, FeedbackResolvePort, KnowHowService};

const NOW: &str = "2026-09-23T00:00:00.000Z";

struct TestHost;

impl CognitionCoordinationHost for TestHost {
    fn process_id(&self) -> u32 {
        std::process::id()
    }

    fn hostname(&self) -> CoordinationResult<String> {
        Ok("knowhow-store-test".into())
    }

    fn process_status(&self, _pid: u64) -> CognitionProcessStatus {
        CognitionProcessStatus::Alive
    }

    fn new_uuid(&self) -> String {
        uuid::Uuid::new_v4().to_string()
    }

    fn now_epoch_millis(&self) -> i64 {
        crate::js_date::parse_iso_millis(NOW).expect("valid test timestamp")
    }

    fn now_iso(&self) -> String {
        NOW.into()
    }
}

struct LockProbe {
    coordinator: CognitionWriteCoordinator,
    lock_path: PathBuf,
    resolved: Mutex<Vec<String>>,
}

impl FeedbackResolvePort for LockProbe {
    fn resolve_applied<'a>(&'a self, feedback_id: &'a str) -> FeedbackResolveFuture<'a> {
        let feedback_id = feedback_id.to_owned();
        Box::pin(async move {
            let lease = self
                .coordinator
                .try_acquire(&CognitionWriteAcquire::immediate(
                    self.lock_path.clone(),
                    "knowhow-test-resolver",
                ))
                .map_err(|error| CognitionError::new(error.code, error.message))?
                .ok_or_else(|| {
                    CognitionError::new("test_lock_busy", "KnowHow held the lock during resolve")
                })?;
            lease
                .release(true)
                .map_err(|error| CognitionError::new(error.code, error.message))?;
            self.resolved
                .lock()
                .expect("resolver mutex")
                .push(feedback_id);
            Ok(())
        })
    }
}

fn temp_root() -> PathBuf {
    std::env::temp_dir().join(format!(
        "butler-knowhow-store-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ))
}

fn entry(id: &str, updated_at: &str) -> Value {
    json!({
        "schema": "butler.cognition.knowhow.v1",
        "knowhow_id": id,
        "name": id,
        "aliases": ["helper"],
        "status": "active",
        "scope": "global",
        "created_at": NOW,
        "updated_at": updated_at,
        "summary": "A test procedure.",
        "intent_match": {"topics": ["topic"], "examples": ["example"]},
        "preconditions": [],
        "strategy": {"steps": ["step"], "preferred_sources": ["shared-source"]},
        "freshness": {
            "max_age_minutes": 60,
            "requires_source_timestamp": true,
            "fallback_when_stale": "try_next_source"
        },
        "fallback": {
            "when_unavailable": "generic_tool_routing",
            "when_negative_feedback": "suppress_and_review"
        },
        "quality": {
            "score": 0.8,
            "confidence": 0.7,
            "success_count": 1,
            "failure_count": 0,
            "negative_feedback_count": 0,
            "last_used_at": null,
            "last_validated_at": null,
            "custom_quality": "keep"
        },
        "refs": {
            "box_item_ids": [],
            "memory_chunk_ids": [],
            "feedback_ids": [],
            "consolidation_run_ids": [],
            "custom_refs": ["keep"]
        },
        "revision_history": [],
        "custom_metadata": {"keep": true}
    })
}

fn write_entry(root: &Path, value: &Value) {
    let directory = root.join("cognition/know-how/entries");
    fs::create_dir_all(&directory).expect("create entries directory");
    let id = value["knowhow_id"].as_str().expect("entry id");
    fs::write(
        directory.join(format!("{id}.json")),
        serde_json::to_vec_pretty(value).expect("serialize entry"),
    )
    .expect("write entry");
}

fn read_entry(root: &Path, id: &str) -> Value {
    serde_json::from_slice(
        &fs::read(root.join(format!("cognition/know-how/entries/{id}.json"))).expect("read entry"),
    )
    .expect("parse entry")
}

#[tokio::test]
async fn aggregation_builds_index_and_revision_resolves_each_target_without_holding_lock() {
    let root = temp_root();
    let entries = root.join("cognition/know-how/entries");
    fs::create_dir_all(&entries).expect("create entries directory");
    write_entry(&root, &entry("kh_older", "2026-09-22T00:00:00.000Z"));
    write_entry(&root, &entry("kh_newer", "2026-09-23T00:00:00.000Z"));
    fs::write(
        root.join("cognition/know-how/source-quality.jsonl"),
        concat!(
            "{malformed row}\n",
            "{\"source_id\":\"shared-source\",\"tool_name\":\"search\",\"observed_at\":\"2026-09-23T00:00:00.000Z\",\"freshness_score\":1.0,\"success\":true,\"latency_ms\":0,\"user_feedback\":\"none\"}\n"
        ),
    )
    .expect("write source quality log");

    let coordinator = CognitionWriteCoordinator::new(Arc::new(TestHost)).expect("coordinator");
    let lock_path = root.join("cognition/consolidation/locks/consolidation.lock");
    let service = KnowHowService::new(
        root.clone(),
        CognitionPathEnvironment::default(),
        Arc::new(coordinator.clone()),
    );
    let aggregate = service
        .aggregate_and_rebuild()
        .await
        .expect("aggregate and rebuild");
    assert_eq!(aggregate.source_quality_summary_count, 1);
    assert_eq!(aggregate.knowhow_indexed_count, 2);
    assert_eq!(service.count_entries().await.expect("count entries"), 2);

    let index_path = root.join("cognition/know-how/index.sqlite");
    let database = Connection::open_with_flags(&index_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("open index read-only");
    let indexed_active: i64 = database
        .query_row(
            "SELECT COUNT(*) FROM knowhow_entries WHERE status='active'",
            [],
            |row| row.get(0),
        )
        .expect("query indexed rows");
    let topic_terms: i64 = database
        .query_row(
            "SELECT COUNT(*) FROM knowhow_terms WHERE term='topic' AND kind='topic'",
            [],
            |row| row.get(0),
        )
        .expect("query terms");
    assert_eq!(indexed_active, 2);
    assert_eq!(topic_terms, 2);
    drop(database);

    let probe = LockProbe {
        coordinator,
        lock_path,
        resolved: Mutex::new(Vec::new()),
    };
    let feedback = [FeedbackTarget {
        feedback_id: "fb_shared".into(),
        category: "source_policy".into(),
        promotion_target: "knowhow".into(),
        target_ref: "source:shared-source".into(),
    }];
    let revised = service
        .revise(&feedback, &probe)
        .await
        .expect("revise targeted entries");
    assert_eq!(revised.revised_knowhow_count, 2);
    assert_eq!(revised.demoted_knowhow_count, 0);
    assert_eq!(revised.applied_feedback_count, 2);
    let resolved = probe.resolved.lock().expect("resolver mutex");
    assert_eq!(resolved.len(), 2);
    assert!(resolved.iter().all(|id| id == "fb_shared"));
    drop(resolved);

    for id in ["kh_older", "kh_newer"] {
        let revised = read_entry(&root, id);
        assert_eq!(revised["status"], "disabled");
        assert_eq!(revised["refs"]["feedback_ids"], json!(["fb_shared"]));
        assert_eq!(revised["refs"]["custom_refs"], json!(["keep"]));
        assert_eq!(revised["quality"]["custom_quality"], "keep");
        assert_eq!(revised["custom_metadata"]["keep"], true);
    }
    let database = Connection::open_with_flags(&index_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("reopen unchanged index");
    let stale_active: i64 = database
        .query_row(
            "SELECT COUNT(*) FROM knowhow_entries WHERE status='active'",
            [],
            |row| row.get(0),
        )
        .expect("query unchanged index");
    assert_eq!(stale_active, 2);
    drop(database);
    fs::remove_dir_all(root).expect("remove fixture");
}
