use super::*;
use rusqlite::{Connection, params};
use serde_json::{Value, json};

pub(in crate::cognition::graph::recall) fn fixture() -> Connection {
    let db = Connection::open_in_memory().unwrap();
    db.execute_batch(
        "CREATE TABLE memory_nodes(id TEXT PRIMARY KEY,type TEXT);
         CREATE TABLE memory_chunks(memory_chunk_id TEXT PRIMARY KEY,current_revision TEXT,status TEXT,project_id TEXT,conversation_session_id TEXT);
         CREATE TABLE memory_chunk_sources(source_id TEXT PRIMARY KEY,episode_id TEXT,revision TEXT,source_kind TEXT,origin_kind TEXT,role TEXT,basis TEXT,observed_at TEXT,conversation_message_id TEXT);
         CREATE TABLE memory_aliases(node_id TEXT,surface_original TEXT,nfc_key TEXT,folded_key TEXT,source_id TEXT);
         CREATE TABLE memory_alias_postings(gram TEXT,node_id TEXT,source_id TEXT,surface_original TEXT);
         CREATE TABLE memory_claims(node_id TEXT,valid_from TEXT,valid_to TEXT,salience TEXT);
         CREATE TABLE memory_evidence(episode_id TEXT,node_id TEXT,source_id TEXT,revision TEXT);",
    ).unwrap();
    let rows = [
        (
            "n-active",
            Some("s1"),
            "p1",
            "2026-01-02T00:00:00Z",
            "user_input",
            "goal",
            Some("2026-01-01"),
            None,
            "conversation",
        ),
        (
            "n-other-session",
            Some("s2"),
            "p1",
            "2026-01-03T00:00:00Z",
            "user_input",
            "entity",
            None,
            None,
            "conversation",
        ),
        (
            "n-other-project",
            Some("s3"),
            "p2",
            "2026-01-04T00:00:00Z",
            "user_input",
            "entity",
            None,
            None,
            "conversation",
        ),
        (
            "n-expired",
            Some("s1"),
            "p1",
            "2026-01-05T00:00:00Z",
            "user_input",
            "goal",
            Some("2026-01-01"),
            Some("2026-01-10"),
            "conversation",
        ),
        (
            "n-internal",
            Some("s1"),
            "p1",
            "2026-01-06T00:00:00Z",
            "internal_control",
            "entity",
            None,
            None,
            "conversation",
        ),
        (
            "n-future",
            Some("s1"),
            "p1",
            "2026-03-01T00:00:00Z",
            "user_input",
            "entity",
            None,
            None,
            "conversation",
        ),
        (
            "n-task",
            None,
            "p1",
            "2026-01-07T00:00:00Z",
            "task",
            "entity",
            None,
            None,
            "task_report",
        ),
    ];
    for (id, session, project, observed, origin, kind, from, to, source_kind) in rows {
        let episode = format!("e-{id}");
        let source = format!("src-{id}");
        db.execute("INSERT INTO memory_nodes VALUES(?1,?2)", params![id, kind])
            .unwrap();
        db.execute(
            "INSERT INTO memory_chunks VALUES(?1,'r','active',?2,?3)",
            params![episode, project, session],
        )
        .unwrap();
        db.execute(
            "INSERT INTO memory_chunk_sources VALUES(?1,?2,'r',?3,?4,?5,?6,?7,NULL)",
            params![
                source,
                episode,
                source_kind,
                origin,
                if source_kind == "task_report" {
                    "task"
                } else {
                    "user"
                },
                if source_kind == "task_report" {
                    "reviewed_task"
                } else {
                    "user_statement"
                },
                observed
            ],
        )
        .unwrap();
        db.execute(
            "INSERT INTO memory_aliases VALUES(?1,'abc','abc','abc',?2)",
            params![id, source],
        )
        .unwrap();
        for gram in crate::cognition::lexical::folded_grams("abc") {
            db.execute(
                "INSERT INTO memory_alias_postings VALUES(?1,?2,?3,'abc')",
                params![gram, id, source],
            )
            .unwrap();
        }
        db.execute(
            "INSERT INTO memory_evidence VALUES(?1,?2,?3,'r')",
            params![episode, id, source],
        )
        .unwrap();
        if let Some(from) = from {
            db.execute(
                "INSERT INTO memory_claims VALUES(?1,?2,?3,'normal')",
                params![id, from, to],
            )
            .unwrap();
        }
    }
    db
}

#[test]
fn scoped_semantic_selection_matches_source_bun() {
    let db = fixture();
    let golden: Value = serde_json::from_str(include_str!("fixtures/source-bun.json")).unwrap();
    for case in [
        "all",
        "current_session",
        "current_project",
        "selected_project",
        "include_internal",
        "event_window",
    ] {
        let mut request = json!({
            "cue":"abc","seedPhrases":[],"vectorQueries":[],"includeVector":false,
            "includeInternal":case=="include_internal","limit":10,"scope":"all_user_sessions",
            "projectFilter":"any","projectIds":[],"sessionIds":[],
            "asOf":"2026-02-01T00:00:00.000Z","time":null,"cursor":null,
            "admittedChannels":{"graph":true,"lexical":true,"vector":false,"context":false,"explicit":true,"task":true},
            "runtime":{"sessionId":"s1","turnId":"t","currentUserMessage":"m","nativeOperationId":"op","projectId":"p1"}
        });
        if case == "current_session" {
            request["scope"] = json!("current_session");
        }
        if case == "current_project" {
            request["scope"] = json!("current_project");
        }
        if case == "selected_project" {
            request["projectFilter"] = json!("selected");
            request["projectIds"] = json!(["p2"]);
        }
        if case == "event_window" {
            request["time"] = json!({"basis":"event","from":"2026-01-02","to":"2026-01-09"});
        }
        let input: RecallRequest = serde_json::from_value(request).unwrap();
        let selected = select(&db, &input, &[], &[], i64::MAX, || 0).unwrap();
        assert_eq!(
            json!(selected.all_seeds),
            golden[case]["allSeeds"],
            "{case}"
        );
        assert_eq!(
            json!(selected.coverage_codes),
            golden[case]["coverageCodes"],
            "{case}"
        );
    }
}
