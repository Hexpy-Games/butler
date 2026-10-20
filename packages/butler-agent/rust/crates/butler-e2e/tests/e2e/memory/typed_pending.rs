//! A source-written rule transaction can fail its index write before recovery.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "E2E assertions"
)]
use super::coverage_seed::{recovered, session};
use super::coverage_support::{canonical, graph, hold_gate, release_gate, start};
use super::standalone_upgrade::reset_pending;
use butler_e2e::e2e::HarnessError;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::Write,
    path::Path,
    time::{Duration, Instant},
};
const AT: &str = "2026-03-10T00:00:00.000Z";

#[tokio::test]
async fn mem_typed_pending_rule_recovers_without_terminal_failure() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = start("MEM-TYPED-PENDING", &[]).await?;
    let data = s.sandbox.data.clone();
    let root = data.join("cognition/memory/rules");
    let gate = hold_gate(&data);
    let (binding, entry) = seed(&data, "pending-rule");
    seed(&data, "deleted-rule");
    release_gate(&gate);
    drop(gate);
    wait(|| {
        count(&data, "pending-rule", "complete") > 0 && count(&data, "deleted-rule", "complete") > 0
    })
    .await;
    let gate = hold_gate(&data);
    let db = graph(&data);
    for id in ["pending-rule", "deleted-rule"] {
        reset_pending(&db, &format!("explicit_record:{id}"));
    }
    // Crash snapshot after Remember wrote the source, but INDEX.md failed.
    // Recovery finishes this same revision, without committing a correction.
    let inventory = json!({"scopes":{"global":{"R1234567890":entry}}});
    let intent = json!({"request":{"Remember":{"input":{"text":"Keep this durable instruction.",
        "operation_id":"pending-rule","duration":"always"},"target":null}},
        "entry":entry,"text":"Keep this durable instruction.","binding":binding,
        "previous":null,"previous_text":null,"inventory":inventory});
    std::fs::write(root.join("pending.json"), intent.to_string())?;
    let index = root.join("INDEX.md");
    if index.exists() {
        std::fs::remove_file(&index)?;
    }
    std::fs::create_dir(&index)?;
    for ext in ["md", "source.json"] {
        std::fs::remove_file(root.join(format!("deleted-rule.{ext}")))?;
    }
    session(&canonical(&data), "queue-neighbor", None);
    recovered(
        &canonical(&data),
        "queue-neighbor",
        1,
        "Unrelated complete fact.",
        AT,
    );
    release_gate(&gate);
    drop(gate);
    let started = Instant::now();
    wait(|| db.query_row("SELECT last_served_at IS NOT NULL FROM memory_projection_jobs j JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id WHERE c.source_key='explicit_record:pending-rule'", [], |r| r.get::<_, bool>(0)).unwrap()).await;
    assert_eq!(
        count(&data, "pending-rule", "failed"),
        0,
        "still-current rule was permanently failed while its transaction awaited recovery"
    );
    let paced: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM memory_projection_windows w JOIN memory_projection_jobs j USING(job_id) JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id WHERE c.source_key='explicit_record:pending-rule' AND w.state='pending' AND w.next_attempt_at IS NOT NULL)", [], |r| r.get(0)).unwrap();
    assert!(paced, "unavailable source must be paced");
    wait(|| count(&data, "deleted-rule", "failed") > 0).await;
    super::coverage_support::settle(&data, &["queue-neighbor"]).await;
    s.agent.terminate().await?;
    std::fs::remove_dir(index)?;
    s.gw = s.agent.start_again().await?;
    wait(|| !root.join("pending.json").exists()).await;
    wait(|| count(&data, "pending-rule", "complete") == 1).await;
    assert_eq!(count(&data, "pending-rule", "failed"), 0);
    let current: Value =
        serde_json::from_slice(&std::fs::read(root.join("pending-rule.source.json"))?)?;
    assert_eq!(current["revision"], binding["revision"]);
    assert_eq!(count(&data, "deleted-rule", "failed"), 1);
    eprintln!(
        "MEM-TYPED-PENDING original_complete=1 original_failed=0 deleted_failed=1 queue_advanced=true recovery_ms={}",
        started.elapsed().as_millis()
    );
    s.finish().await
}

fn seed(data: &Path, id: &str) -> (Value, Value) {
    let memory = data.join("cognition/memory");
    let root = memory.join("rules");
    std::fs::create_dir_all(root.join("operations")).unwrap();
    let text = "Keep this durable instruction.";
    let hash = format!("{:x}", Sha256::digest(text.as_bytes()));
    let identity = json!(["explicit_record", "rule", id, hash, null, null, null]);
    let identity = format!("{:x}", Sha256::digest(identity.to_string().as_bytes()));
    let revision = format!("{:x}", Sha256::digest(format!("{identity}:{id}:active")));
    let binding = json!({"schema":"butler.explicit-rule-binding.v1","state":"active",
        "record_id":id,"revision":revision,"operation_id":id,"content_hash":hash,
        "project_id":null,"conversation_session_id":null,"conversation_message_id":null,
        "observed_at":AT,"operations":[{"operation_id":id,"revision":revision,"state":"written"}]});
    let entry = json!({"handle":"R1234567890","record_id":id,"revision":revision,"content_hash":hash,"project_id":null,"state":"active","duration":"always"});
    std::fs::write(root.join(format!("{id}.md")), text).unwrap();
    std::fs::write(root.join(format!("{id}.source.json")), binding.to_string()).unwrap();
    let source = json!({"kind":"explicit_record","record_kind":"rule","record_id":id,"revision":revision,"operation_id":id});
    // Match the owner's notice identity, so recovery cannot re-register and
    // accidentally revive a window that the claim path wrongly failed.
    let encoded = format!(
        r#"{{"kind":"explicit_record","record_kind":"rule","record_id":{},"revision":{},"operation_id":{}}}"#,
        source["record_id"], source["revision"], source["operation_id"]
    );
    let job = format!("{:x}", Sha256::digest(encoded.as_bytes()));
    let row = json!({"schema_version":"butler.memory-sync-request.v3","job_id":job,"source":source,"created_at":AT});
    std::fs::create_dir_all(memory.join("queue")).unwrap();
    writeln!(
        std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(memory.join("queue/sync.jsonl"))
            .unwrap(),
        "{row}"
    )
    .unwrap();
    (binding, entry)
}
fn count(data: &Path, id: &str, state: &str) -> i64 {
    graph(data).query_row("SELECT COUNT(*) FROM memory_projection_windows w JOIN memory_projection_jobs j USING(job_id) JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id WHERE c.source_key=?1 AND w.state=?2", [format!("explicit_record:{id}"), state.into()], |r| r.get(0)).unwrap()
}
async fn wait(mut ready: impl FnMut() -> bool) {
    tokio::time::timeout(Duration::from_secs(90), async {
        while !ready() {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("typed projection queue did not progress");
}
