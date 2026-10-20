//! Regression for upgraded standalone graph rows and runtime hash mismatches.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
use super::coverage::idle;
use super::coverage_seed::{recovered, session};
use super::coverage_support::{Variant, canonical, drain, graph, hold_gate, release_gate, start};
use butler_e2e::e2e::{HarnessError, scenario::Scenario};
use serde_json::json;
const S5: &str = "upgrade-session";
const MARCH: &str = "2026-03-10T00:00:00.000Z";
fn variants() -> Vec<Variant> {
    vec![Variant {
        prompt: "Recall the upgrade fact.",
        arguments: json!({"cue":"upgrade","session_ids":[S5],"include_vector":false}),
    }]
}

#[tokio::test]
async fn mem_standalone_legacy_hash_upgrade() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = start("MEM-STANDALONE-UPGRADE", &[variants().pop().unwrap()]).await?;
    let data = s.sandbox.data.clone();
    session(&canonical(&data), S5, None);
    recovered(&canonical(&data), S5, 10, "recovered upgrade fact", MARCH);
    recovered(
        &canonical(&data),
        S5,
        11,
        "already completed recovered fact",
        MARCH,
    );
    drain(&data, &[]).await;
    s.agent.terminate().await?;
    let db = graph(&data);
    let key = format!("conversation_message:{S5}-recovered-10");
    let (revision, hash): (String, String) = db
        .query_row(
            "SELECT current_revision,source_hash FROM memory_chunks WHERE source_key=?1",
            [&key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_ne!(revision, hash);
    // Pre-fix registration wrote the episode revision into source_hash.
    // Keep its already-known observation and the same canonical revision.
    db.execute("UPDATE memory_chunks SET source_hash=current_revision WHERE source_key LIKE 'conversation_message:%'", []).unwrap();
    reset_pending(&db, &key);
    db.execute(
        "DELETE FROM memory_state WHERE key LIKE 'standalone_hash_repair_%'",
        [],
    )
    .unwrap();
    s.gw = s.agent.start_again().await?;
    drain(&data, &[]).await;
    let after: (String, String) = db
        .query_row(
            "SELECT current_revision,source_hash FROM memory_chunks WHERE source_key=?1",
            [&key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        after,
        (revision, hash),
        "repair must retain the canonical revision and restore the parts hash"
    );
    let broken: i64 = db.query_row("SELECT COUNT(*) FROM memory_chunks WHERE source_key LIKE 'conversation_message:%' AND source_hash=current_revision", [], |r| r.get(0)).unwrap();
    assert_eq!(broken, 0, "completed legacy chunks must also be repaired");
    let migrated: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM memory_state WHERE key='standalone_hash_repair_complete')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(migrated, "one-time repair was not recorded");
    s.agent.terminate().await?;
    db.execute(
        "UPDATE memory_chunks SET source_hash='outdated-metadata' WHERE source_key=?1",
        [&key],
    )
    .unwrap();
    reset_pending(&db, &key);
    s.gw = s.agent.start_again().await?;
    drain(&data, &[]).await;
    let runtime_hash: String = db
        .query_row(
            "SELECT source_hash FROM memory_chunks WHERE source_key=?1",
            [&key],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(runtime_hash, after.1, "runtime mismatch was not refreshed");
    let gate = hold_gate(&data);
    assert_standalone_cache(&s, &key).await?;
    let gate = idle(&s, gate).await;
    release_gate(&gate);
    s.finish().await
}

/// Exercise the production prompt reader and its live hot-cache validator
/// with a source-backed entry, independent of the stub extractor's summary.
async fn assert_standalone_cache(s: &Scenario, key: &str) -> Result<(), HarnessError> {
    let data = &s.sandbox.data;
    let db = graph(data);
    let (episode, revision, window, source, session): (String, String, String, String, String) = db.query_row(
        "SELECT c.memory_chunk_id,c.current_revision,w.window_ref,s.source_id,c.conversation_session_id FROM memory_chunks c JOIN memory_projection_jobs j ON j.episode_id=c.memory_chunk_id AND j.revision=c.current_revision JOIN memory_projection_windows w ON w.job_id=j.job_id JOIN memory_chunk_sources s ON s.episode_id=c.memory_chunk_id AND s.revision=c.current_revision WHERE c.source_key=?1 LIMIT 1",
        [key], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)),
    ).unwrap();
    let entry = json!({"entry_id":"upgrade-cache-entry","episode_id":episode,
        "source_revision":revision,"window_ref":window,"source_refs":[source],
        "session_id":session,"graph_revision":0,"source_time":MARCH,
        "summary":"Validated standalone cache admission","authority":"model_interpretation"});
    let path = super::memory_stubs::graph_path(data)
        .unwrap()
        .parent()
        .unwrap()
        .join("hot/cache.md");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let original = std::fs::read(&path).unwrap_or_default();
    std::fs::write(&path, format!("<!-- butler-semantic:upgrade-cache-entry:start -->\n<!-- butler-hot-cache-entry:v2\n{entry}\n-->\nValidated standalone cache admission\n<!-- butler-semantic:upgrade-cache-entry:end -->\n")).unwrap();
    let before = s.provider()?.requests().len();
    s.turn("general", variants().pop().unwrap().prompt).await?;
    let accepted = s.provider()?.requests()[before]
        .to_string()
        .contains("Validated standalone cache admission");
    std::fs::write(path, original).unwrap();
    assert!(
        accepted,
        "hot-cache validation rejected the repaired standalone source"
    );
    Ok(())
}

/// A registered, unprocessed window has no saved extraction output or plan.
fn reset_pending(db: &butler_platform::sqlite::Connection, key: &str) {
    db.execute("UPDATE memory_projection_windows SET state='pending',owner_nonce=NULL,owner_pid=NULL,next_attempt_at=NULL,attempt_count=0,output_json=NULL,normalized_plan_json=NULL,provider_evidence_json=NULL,input_json=NULL,input_sha256=NULL,extraction_stages_json='{}' WHERE job_id IN (SELECT j.job_id FROM memory_projection_jobs j JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id WHERE c.source_key=?1)", [key]).unwrap();
    db.execute("DELETE FROM memory_projection_attempts WHERE job_id IN (SELECT j.job_id FROM memory_projection_jobs j JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id WHERE c.source_key=?1)", [key]).unwrap();
    db.execute("UPDATE memory_projection_jobs SET semantic_graph_state='{\"state\":\"pending\"}',last_served_at=NULL WHERE episode_id IN (SELECT memory_chunk_id FROM memory_chunks WHERE source_key=?1)", [key]).unwrap();
}
