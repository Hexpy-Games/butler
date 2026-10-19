use std::collections::HashSet;

use butler_platform::sqlite::Connection;
use serde_json::json;

use super::{ClaimProjectionWindowInput, PreviousWindowState, claim, pin_input};
use crate::coordination::CognitionProcessStatus;

fn database() -> Connection {
    let connection = Connection::open_in_memory().unwrap();
    connection.execute_batch("CREATE TABLE memory_projection_jobs(job_id TEXT PRIMARY KEY,extraction_model TEXT NOT NULL,reasoning_effort TEXT NOT NULL,semantic_graph_state TEXT NOT NULL,last_served_at TEXT,created_at TEXT NOT NULL);
        CREATE TABLE memory_projection_windows(window_ref TEXT PRIMARY KEY,job_id TEXT NOT NULL,ordinal INTEGER NOT NULL,source_refs_json TEXT NOT NULL,state TEXT NOT NULL,output_json TEXT,normalized_plan_json TEXT,attempt_count INTEGER NOT NULL DEFAULT 0,recovery_base_attempt_count INTEGER NOT NULL DEFAULT 0,recovery_revision TEXT,input_json TEXT,input_sha256 TEXT,input_migration_note TEXT,next_attempt_at TEXT,owner_pid INTEGER,owner_nonce TEXT,started_at TEXT,error_code TEXT,provider_evidence_json TEXT);
        CREATE TABLE memory_projection_attempts(attempt_ref TEXT PRIMARY KEY,window_ref TEXT NOT NULL,job_id TEXT NOT NULL,attempt_count INTEGER NOT NULL,state TEXT NOT NULL,error_code TEXT,input_sha256 TEXT,output_json TEXT,provider_evidence_json TEXT,recorded_at TEXT NOT NULL,attempt_kind TEXT NOT NULL,provider_invoked INTEGER NOT NULL,outcome_known INTEGER NOT NULL,invocation_ref TEXT,recovery_revision TEXT);
        CREATE TABLE memory_projection_model_policy(id INTEGER PRIMARY KEY,primary_model TEXT,primary_effort TEXT,fallback_model TEXT,fallback_effort TEXT,active_slot TEXT,updated_at TEXT NOT NULL DEFAULT 'x',last_transition_json TEXT);").unwrap();
    connection.execute("INSERT INTO memory_projection_jobs VALUES('job','job/model','low','{}',NULL,'2026-01-01T00:00:00.000Z')", []).unwrap();
    connection.execute("INSERT INTO memory_projection_windows(window_ref,job_id,ordinal,source_refs_json,state) VALUES('window','job',0,'[\"source\"]','pending')", []).unwrap();
    connection
}

#[test]
fn claim_pins_exact_input_and_enforces_nonce() {
    let mut connection = database();
    connection.execute("INSERT INTO memory_projection_model_policy(id,primary_model,primary_effort,fallback_model,fallback_effort,active_slot) VALUES(1,'policy/model','high','fallback/model','low','primary')",[]).unwrap();
    let active = HashSet::new();
    let claimed = claim(
        &mut connection,
        ClaimProjectionWindowInput {
            job_id: Some("job"),
            now: "2026-01-02T00:00:00.000Z",
            owner_pid: 7,
            owner_nonce: "nonce",
            active_owners: &active,
            process_status: &|_| CognitionProcessStatus::Alive,
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(claimed.previous_state, PreviousWindowState::Pending);
    assert_eq!(claimed.source_refs, ["source"]);
    assert_eq!(claimed.model, "policy/model");
    let input: crate::cognition::extraction::ExtractInput = serde_json::from_value(json!({
        "schema":"butler.memory-extract-input.v2","episode_ref":"e","revision":"r",
        "window_ref":"window","bound_project_id":null,"source_units":[],"context_units":[],
        "candidates":[]}))
    .unwrap();
    pin_input(&connection, "window", "nonce", &input, None).unwrap();
    let stored: String = connection
        .query_row(
            "SELECT input_json FROM memory_projection_windows",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        stored,
        r#"{"schema":"butler.memory-extract-input.v2","episode_ref":"e","revision":"r","window_ref":"window","bound_project_id":null,"source_units":[],"context_units":[],"candidates":[]}"#
    );
    assert_eq!(
        pin_input(&connection, "window", "wrong", &input, None)
            .unwrap_err()
            .code(),
        "memory_projection_window_changed"
    );
}

#[test]
fn persisted_policy_is_used_by_the_next_claim() {
    let mut graph = crate::cognition::graph::GraphRepository {
        _reader_pin: None,
        connection: Some(database()),
    };
    // Existing policy rows remain part of live claim selection after removing
    // the unused operator configuration API.
    graph.connection.as_ref().unwrap().execute(
        "INSERT INTO memory_projection_model_policy(id,primary_model,primary_effort,fallback_model,fallback_effort,active_slot,updated_at) VALUES(1,'new/model','high','fallback/model','low','primary','2026-01-02T00:00:00.000Z')", [],
    ).unwrap();
    let active = HashSet::new();
    let claimed = graph
        .claim_projection_window(ClaimProjectionWindowInput {
            job_id: Some("job"),
            now: "2026-01-02T00:00:01.000Z",
            owner_pid: 7,
            owner_nonce: "nonce",
            active_owners: &active,
            process_status: &|_| CognitionProcessStatus::Alive,
        })
        .unwrap()
        .unwrap();
    assert_eq!(claimed.model, "new/model");
    assert_eq!(claimed.reasoning_effort, "high");
}

// test-category: race
#[test]
fn abandoned_unknown_invocation_is_deferred_before_next_selection() {
    only_dead_process_unknown_invocations_spend_the_cap();
    let mut connection = database();
    connection.execute("UPDATE memory_projection_windows SET state='running',attempt_count=1,owner_pid=7,owner_nonce='old',started_at='x'",[]).unwrap();
    connection.execute("INSERT INTO memory_projection_attempts VALUES('intent','window','job',1,'invocation_intent',NULL,NULL,NULL,NULL,'x','provider_intent',0,0,'old',NULL)",[]).unwrap();
    let active = HashSet::new();
    let result = claim(
        &mut connection,
        ClaimProjectionWindowInput {
            job_id: Some("job"),
            now: "2026-01-02T00:00:00.000Z",
            owner_pid: 7,
            owner_nonce: "new",
            active_owners: &active,
            process_status: &|_| CognitionProcessStatus::Alive,
        },
    )
    .unwrap();
    assert!(result.is_none());
    let row: (String, String, Option<String>) = connection
        .query_row(
            "SELECT state,error_code,next_attempt_at FROM memory_projection_windows",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        row,
        (
            "pending".into(),
            "memory_projection_interrupted".into(),
            Some("2026-01-02T00:00:30.000Z".into())
        )
    );
    let interrupted: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM memory_projection_attempts WHERE state='interrupted'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(interrupted, 1);
    assert!(
        claim(
            &mut connection,
            ClaimProjectionWindowInput {
                job_id: Some("job"),
                now: "2026-01-02T00:00:30.000Z",
                owner_pid: 7,
                owner_nonce: "new",
                active_owners: &active,
                process_status: &|_| CognitionProcessStatus::Alive,
            }
        )
        .unwrap()
        .is_some()
    );
}

fn only_dead_process_unknown_invocations_spend_the_cap() {
    for (dead, intent, known) in [
        (true, true, false),
        (false, true, false),
        (true, false, false),
        (true, true, true),
    ] {
        let mut db = database();
        for attempt in 1..=4 {
            let nonce = format!("owner-{attempt}");
            db.execute("UPDATE memory_projection_windows SET state='running',attempt_count=?1,owner_pid=7,owner_nonce=?2,next_attempt_at=NULL", rusqlite::params![attempt,nonce]).unwrap();
            if intent {
                db.execute("INSERT INTO memory_projection_attempts(attempt_ref,window_ref,job_id,attempt_count,state,recorded_at,attempt_kind,provider_invoked,outcome_known,invocation_ref) VALUES(?1,'window','job',?2,'invocation_intent','x','provider_intent',0,?3,?1)", rusqlite::params![nonce,attempt,i64::from(known)]).unwrap();
            }
            let active = HashSet::new();
            let input = ClaimProjectionWindowInput {
                job_id: Some("job"),
                now: "2026-01-02T00:00:00.000Z",
                owner_pid: if dead { 8 } else { 7 },
                owner_nonce: "new",
                active_owners: &active,
                process_status: &|_| CognitionProcessStatus::DefinitelyDead,
            };
            let tx = db.transaction().unwrap();
            super::recover_interrupted(&tx, &input).unwrap();
            tx.commit().unwrap();
            let charged = dead && intent && !known;
            assert_eq!(
                super::failed_provider_attempt_count(&db, "window", None).unwrap(),
                if charged { attempt } else { 0 }
            );
            let state: String = db
                .query_row("SELECT state FROM memory_projection_windows", [], |r| {
                    r.get(0)
                })
                .unwrap();
            assert_eq!(
                state,
                if charged && attempt >= 3 {
                    "failed"
                } else {
                    "pending"
                }
            );
        }
    }
}
