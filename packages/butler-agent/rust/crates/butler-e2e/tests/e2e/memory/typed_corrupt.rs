//! Durable rule damage settles once; owner corrections publish fresh work.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "E2E assertions"
)]
use super::super::memory_wiring_more::support as rules;
use super::coverage_seed::{recovered, session};
use super::coverage_support::{canonical, drain, graph, hold_gate, release_gate};
use super::standalone_upgrade::reset_pending;
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Scenario, Setup},
};
use serde_json::{Value, json};
use std::{
    path::Path,
    time::{Duration, Instant},
};

const SAVE: &str = "Save a durable instruction.";
const EDIT: &str = "Correct the saved instruction.";
const REPAIRED: &str = "Correct the instruction after restoring its verified source.";

#[tokio::test]
async fn mem_typed_corrupt_rule_settles_and_edit_revives() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    damaged_rule(false).await
}

#[tokio::test]
async fn mem_typed_corrupt_rule_missing_settles_and_forget_completes() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    damaged_rule(true).await
}

async fn start() -> Result<Scenario, HarnessError> {
    let mut cassette = Cassette::load("MEM-01")?;
    rules::add_call(
        &mut cassette,
        SAVE,
        "update_explicit_memory",
        &json!({"kind":"rule","text":"Keep this durable instruction.","duration":"always","source":SAVE}),
    );
    rules::add_call(
        &mut cassette,
        EDIT,
        "update_explicit_memory",
        &json!({"kind":"rule","text":"Keep this corrected durable instruction.","duration":"always","source":EDIT,"replaces":"{{TARGET}}"}),
    );
    rules::add_call(
        &mut cassette,
        REPAIRED,
        "update_explicit_memory",
        &json!({"kind":"rule","text":"Keep this corrected durable instruction.","duration":"always","source":REPAIRED,"replaces":"{{TARGET}}"}),
    );
    rules::historical(&mut cassette);
    let s = Setup::new("MEM-TYPED-CORRUPT")?
        .stub_cassette(cassette)
        .start()
        .await?;
    s.provider()?.set_memory_responder(rules::meaning);
    s.patch_settings(json!({"access_mode":"full_access"}), "access")
        .await?;
    s.select_model(&s.model).await?;
    Ok(s)
}

async fn damaged_rule(missing: bool) -> Result<(), HarnessError> {
    let s = start().await?;
    let saved = rules::tool(&s, "general", SAVE, "update_explicit_memory").await?;
    assert_eq!(saved["ok"], true, "{saved}");
    let rule = rules::active_rules(&s.sandbox.data).pop().unwrap();
    rules::projection(&s.sandbox.data, &rule).await;
    let data = &s.sandbox.data;
    drain(data, &[]).await;
    let key = format!("explicit_record:{}", rule["record_id"].as_str().unwrap());
    let db = graph(data);
    let gate = hold_gate(data);
    reset_pending(&db, &key);
    let path = data
        .join("cognition/memory/rules")
        .join(format!("{}.md", rule["record_id"].as_str().unwrap()));
    if missing {
        std::fs::remove_file(&path)?;
    } else {
        std::fs::write(&path, "Unverified hand-edited instruction.")?;
    }
    assert!(!data.join("cognition/memory/rules/pending.json").exists());
    session(&canonical(data), "corrupt-neighbor", None);
    recovered(
        &canonical(data),
        "corrupt-neighbor",
        1,
        "Unrelated complete fact.",
        "2026-03-10T00:00:00.000Z",
    );
    release_gate(&gate);
    drop(gate);
    let started = Instant::now();
    // Inspect the first source-validity outcome, including main's busy deferral.
    rules::until(|| snapshot(data, &key)[0]["error_code"].is_string()).await;
    let windows = snapshot(data, &key);
    assert_ne!(windows, [] as [Value; 0]);
    for window in &windows {
        assert_eq!(
            window["state"], "failed",
            "first claim must settle: {windows:?}"
        );
        assert!(
            window["error_code"]
                .as_str()
                .unwrap()
                .starts_with("memory_source_")
        );
        assert!(window["next_attempt_at"].is_null());
        assert_eq!(window["attempt_count"], 0);
    }
    let attempts: i64 = db.query_row("SELECT COUNT(*) FROM memory_projection_attempts a JOIN memory_projection_jobs j USING(job_id) JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id WHERE c.source_key=?1", [&key], |r| r.get(0)).unwrap();
    assert_eq!(attempts, 0);
    super::coverage_support::settle(data, &["corrupt-neighbor"]).await;
    let complete: i64 = db.query_row("SELECT COUNT(*) FROM memory_projection_windows w JOIN memory_projection_jobs j USING(job_id) JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id WHERE c.conversation_session_id='corrupt-neighbor' AND w.state='complete'", [], |r| r.get(0)).unwrap();
    assert_eq!(complete, 1);
    eprintln!(
        "MEM-TYPED-CORRUPT missing={missing} terminal={} unrelated_complete={complete} settle_ms={}",
        windows.len(),
        started.elapsed().as_millis()
    );
    idle(&s, &key, &windows).await;
    repair(&s, &rule, &key, &path, missing).await?;
    eprintln!("MEM-TYPED-CORRUPT missing={missing} owner_change_completed=true");
    s.finish().await
}

async fn repair(
    s: &Scenario,
    rule: &Value,
    key: &str,
    path: &Path,
    missing: bool,
) -> Result<(), HarnessError> {
    let data = &s.sandbox.data;
    if missing {
        // The owner requires prior text for its archive. Restoring verified bytes
        // alone sends no notice; the normal forget below publishes the change.
        std::fs::write(path, "Keep this durable instruction.")?;
        let reply = s.gw.send(reqwest::Method::DELETE, &format!("/memory/instructions/{}", rule["handle"].as_str().unwrap()), Some(json!({"expected_revision":rule["revision"],"project_id":null,"operation_id":uuid::Uuid::new_v4().to_string()}).to_string())).await?;
        assert_eq!(reply.status, 200, "{}", reply.text);
        rules::until(|| {
            rules::read_json(&path.with_extension("source.json"))
                .is_some_and(|v| v["state"] == "forgotten")
        })
        .await;
        assert_eq!(rules::active_rules(data), [] as [Value; 0]);
    } else {
        s.provider()?
            .add_placeholder("TARGET", rule["handle"].as_str().unwrap());
        let refused = rules::tool(s, "general", EDIT, "update_explicit_memory").await?;
        assert_eq!(
            refused["error"]["code"], "rule_not_in_snapshot",
            "{refused}"
        );
        // Unverified text cannot enter Active Rules. Restore the verified bytes,
        // then a normal owner correction publishes a new projection notice.
        std::fs::write(path, "Keep this durable instruction.")?;
        let edited = rules::tool(s, "general", REPAIRED, "update_explicit_memory").await?;
        assert_eq!(edited["ok"], true, "{edited}");
        let current = rules::active_rules(data).pop().unwrap();
        assert_eq!(current["record_id"], rule["record_id"]);
        assert_ne!(current["revision"], rule["revision"]);
        wait_current_complete(data, key, &current["revision"]).await;
        assert_eq!(
            std::fs::read_to_string(path)?,
            "Keep this corrected durable instruction."
        );
    }
    Ok(())
}

fn snapshot(data: &Path, key: &str) -> Vec<Value> {
    let db = graph(data);
    db.prepare("SELECT w.state,w.error_code,w.next_attempt_at,w.attempt_count FROM memory_projection_windows w JOIN memory_projection_jobs j USING(job_id) JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id WHERE c.source_key=?1 ORDER BY w.window_ref").unwrap().query_map([key], |r| Ok(json!({"state":r.get::<_,String>(0)?,"error_code":r.get::<_,Option<String>>(1)?,"next_attempt_at":r.get::<_,Option<String>>(2)?,"attempt_count":r.get::<_,i64>(3)?}))).unwrap().map(Result::unwrap).collect()
}

async fn wait_current_complete(data: &Path, key: &str, revision: &Value) {
    rules::until(|| graph(data).query_row("SELECT EXISTS(SELECT 1 FROM memory_projection_jobs j JOIN memory_chunks c ON c.memory_chunk_id=j.episode_id WHERE c.source_key=?1 AND c.current_revision=?2 AND j.revision=c.current_revision AND json_extract(j.semantic_graph_state,'$.state')='complete' AND json_extract(j.hot_cache_state,'$.state')='complete')", rusqlite::params![key, revision.as_str().unwrap()], |r| r.get::<_,bool>(0)).unwrap()).await;
}

async fn idle(s: &Scenario, key: &str, windows: &[Value]) {
    let data = &s.sandbox.data;
    // Existing idle E2Es allow maintenance to finish before observing commits.
    tokio::time::sleep(Duration::from_secs(10)).await;
    let db = graph(data);
    let lock = butler_platform::sqlite::open(
        data.join("cognition/consolidation/locks/consolidation.lock.coord.sqlite"),
    )
    .unwrap();
    let version = |db: &butler_platform::sqlite::Connection| {
        db.pragma_query_value::<u64, _>(None, "data_version", |r| r.get(0))
            .unwrap()
    };
    let before = (version(&db), version(&lock));
    let errors = s.agent.logs().matches("[native-memory-sync]").count();
    tokio::time::sleep(Duration::from_secs(40)).await;
    let commits = version(&db) - before.0;
    let leases = version(&lock) - before.1;
    assert_eq!(commits, 0, "idle graph commits");
    assert_eq!(leases, 0, "idle leases");
    assert_eq!(
        s.agent.logs().matches("[native-memory-sync]").count(),
        errors
    );
    assert_eq!(snapshot(data, key), windows);
    eprintln!(
        "MEM-TYPED-CORRUPT idle_seconds=40 graph_commits={commits} leases={leases} source_errors=0 attempts=0"
    );
}
