use rusqlite::Connection;
use serde_json::json;

use super::*;

fn database(job_id: &str) -> Connection {
    let connection = Connection::open_in_memory().unwrap();
    connection
        .execute_batch(
            "CREATE TABLE memory_projection_jobs(
               job_id TEXT PRIMARY KEY,episode_id TEXT,revision TEXT,
               semantic_graph_state TEXT,episode_vectors_state TEXT,node_vectors_state TEXT,
               last_served_at TEXT);
             CREATE TABLE memory_chunks(
               memory_chunk_id TEXT PRIMARY KEY,current_revision TEXT,project_id TEXT,origin_kind TEXT);
             CREATE TABLE memory_chunk_sources(
               source_id TEXT PRIMARY KEY,episode_id TEXT,revision TEXT,source_kind TEXT,
               conversation_session_id TEXT,conversation_message_id TEXT,part_id TEXT,
               scalar_pointer TEXT,byte_start INTEGER,byte_end INTEGER,content_hash TEXT,
               role TEXT,origin_kind TEXT,observed_at TEXT,basis TEXT);
             CREATE VIEW memory_source_leaves AS SELECT * FROM memory_chunk_sources;
             CREATE TABLE memory_nodes(id TEXT PRIMARY KEY,type TEXT,label_original TEXT);
             CREATE TABLE memory_evidence(node_id TEXT,source_id TEXT,episode_id TEXT,revision TEXT);
             CREATE TABLE memory_aliases(node_id TEXT,surface_original TEXT,source_id TEXT);
             CREATE TABLE memory_claims(node_id TEXT PRIMARY KEY,statement TEXT,condition TEXT,
               requirement TEXT,polarity TEXT);
             CREATE TABLE memory_vector_units(
               unit_id TEXT PRIMARY KEY,job_id TEXT,record_kind TEXT,owner_id TEXT,
               owner_revision TEXT,project_id TEXT,origin_kind TEXT,projection_text TEXT,
               state TEXT DEFAULT 'pending',error_code TEXT,owner_pid INTEGER,owner_nonce TEXT,
               started_at TEXT,receipt_json TEXT,source_ids_json TEXT,source_byte_start INTEGER,
               source_byte_end INTEGER,source_role TEXT);
             INSERT INTO memory_chunks VALUES('episode','revision','project','user_input');
             INSERT INTO memory_chunk_sources VALUES
               ('source','episode','revision','conversation','session','message','part','/text',
                0,5,'hash','user','user_input','2026-01-01T00:00:00Z','user_statement');
             INSERT INTO memory_nodes VALUES('node','preference','Stored label');
             INSERT INTO memory_evidence VALUES('node','source','episode','revision');
             INSERT INTO memory_aliases VALUES('node','Alpha','source');
             INSERT INTO memory_claims VALUES(
               'node','statement','when needed','{\"action\":\"remember\"}','positive');",
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO memory_projection_jobs VALUES(?1,'episode','revision',?2,?3,?3,NULL)",
            rusqlite::params![
                job_id,
                r#"{"state":"complete"}"#,
                r#"{"state":"pending","blocked_by":null}"#
            ],
        )
        .unwrap();
    connection
}

fn source(text: &str) -> EpisodeProjectionSource {
    EpisodeProjectionSource {
        source_id: "source".into(),
        text: text.into(),
        role: "user".into(),
        byte_start: 0,
    }
}

#[test]
fn registration_preserves_projection_digest_source_span_and_pending_states() {
    let mut connection = database("job");
    refresh_vector_units_for_job(&mut connection, "job", &[source("hello🙂")], "now").unwrap();
    let node: (String, String, String) = connection
        .query_row(
            "SELECT projection_text,owner_revision,source_ids_json FROM memory_vector_units WHERE record_kind='node'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    let projection = "type:\"preference\"\nlabel:\"Alpha\"\nstatement:\"statement\"\ncondition:\"when needed\"\nrequirement:{\"action\":\"remember\"}\npolarity:\"positive\"\nalias:\"Alpha\"";
    assert_eq!(node.0, projection);
    let revision = super::digest(vec![
        json!("node-vector"),
        json!("node"),
        json!("project"),
        json!("user_input"),
        json!(projection),
    ])
    .unwrap();
    let chunk = super::digest(vec![
        json!("node-vector-chunk"),
        json!(revision),
        json!(0),
        json!(projection),
    ])
    .unwrap();
    assert_eq!(node.1, chunk);
    assert_eq!(node.2, r#"["source"]"#);

    let episode: (String, i64, i64) = connection
        .query_row(
            "SELECT projection_text,source_byte_start,source_byte_end FROM memory_vector_units WHERE record_kind='episode'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(episode, ("[user] hello🙂".into(), 0, 9));
    let states: (String, String) = connection
        .query_row(
            "SELECT node_vectors_state,episode_vectors_state FROM memory_projection_jobs",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(states.0, r#"{"state":"pending","blocked_by":null}"#);
    assert_eq!(states.1, r#"{"state":"pending","blocked_by":null}"#);
}

#[test]
fn oversized_episode_is_a_failed_unit_and_grapheme_chunks_are_atomic() {
    let mut connection = database("job");
    let text = format!("a{}", "\u{301}".repeat(4_100));
    refresh_vector_units_for_job(&mut connection, "job", &[source(&text)], "now").unwrap();
    let row: (String, String, String) = connection
        .query_row(
            "SELECT projection_text,state,error_code FROM memory_vector_units WHERE record_kind='episode'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        row,
        (String::new(), "failed".into(), OVERSIZED_GRAPHEME.into())
    );
    assert_eq!(super::units::chunks("a🙂b", 5).unwrap(), vec!["a🙂", "b"]);
    assert!(super::units::chunks(&text, 4_000).is_err());
}

#[test]
fn registration_rolls_back_partial_rows_and_reports_episode_stage() {
    let mut connection = database("job");
    connection
        .execute_batch(
            "CREATE TRIGGER fail_episode BEFORE INSERT ON memory_vector_units
             WHEN NEW.record_kind='episode' BEGIN SELECT RAISE(ABORT,'vector-failure'); END;",
        )
        .unwrap();
    let failure =
        refresh_vector_units_for_job(&mut connection, "job", &[source("text")], "now").unwrap_err();
    assert_eq!(failure.stage, VectorRegistrationStage::Episode);
    assert_eq!(failure.error.message, "vector-failure");
    let count: i64 = connection
        .query_row("SELECT COUNT(*) FROM memory_vector_units", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn registration_rejects_a_stale_current_chunk_before_opening_a_transaction() {
    let mut connection = database("job");
    connection
        .execute(
            "UPDATE memory_chunks SET current_revision='new-revision'",
            [],
        )
        .unwrap();
    let failure =
        refresh_vector_units_for_job(&mut connection, "job", &[source("text")], "now").unwrap_err();
    assert_eq!(failure.stage, VectorRegistrationStage::Node);
    assert_eq!(failure.error.code, "memory_source_changed");
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM memory_vector_units", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        0
    );
}

#[test]
fn registration_supersedes_obsolete_units_and_clears_owners() {
    let mut connection = database("job");
    refresh_vector_units_for_job(&mut connection, "job", &[source("text")], "now").unwrap();
    connection
        .execute(
            "UPDATE memory_vector_units SET owner_pid=7,owner_nonce='nonce',started_at='then' WHERE record_kind='episode'",
            [],
        )
        .unwrap();
    refresh_vector_units_for_job(&mut connection, "job", &[source("changed")], "later").unwrap();
    let old: (String, Option<i64>, Option<String>, Option<String>) = connection
        .query_row(
            "SELECT state,owner_pid,owner_nonce,started_at FROM memory_vector_units WHERE record_kind='episode' AND projection_text='[user] text'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(old, ("superseded".into(), None, None, None));
}

#[test]
fn receipt_reuse_stays_pending_and_failure_marker_is_stage_local() {
    let mut connection = database("old");
    refresh_vector_units_for_job(&mut connection, "old", &[source("text")], "now").unwrap();
    connection
        .execute(
            "UPDATE memory_vector_units SET state='complete',receipt_json=?1 WHERE job_id='old' AND record_kind='node'",
            [r#"{"vector":[]}"#],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO memory_projection_jobs VALUES('new','episode','revision',?1,?2,?2,NULL)",
            rusqlite::params![
                r#"{"state":"complete"}"#,
                r#"{"state":"pending","blocked_by":null}"#
            ],
        )
        .unwrap();
    refresh_vector_units_for_job(&mut connection, "new", &[source("text")], "now").unwrap();
    let reused: (String, String, String) = connection
        .query_row(
            "SELECT state,error_code,receipt_json FROM memory_vector_units WHERE job_id='new' AND record_kind='node'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        reused,
        (
            "pending".into(),
            "memory_vector_reuse_pending".into(),
            r#"{"vector":[]}"#.into()
        )
    );

    mark_vector_registration_failure(
        &connection,
        "new",
        "memory_write_busy",
        VectorRegistrationStage::Node,
    )
    .unwrap();
    mark_vector_registration_failure(
        &connection,
        "new",
        "memory_vector_io_transient",
        VectorRegistrationStage::Episode,
    )
    .unwrap();
    let states: (String, String, String) = connection
        .query_row(
            "SELECT semantic_graph_state,node_vectors_state,episode_vectors_state FROM memory_projection_jobs WHERE job_id='new'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(states.0, r#"{"state":"complete"}"#);
    assert_eq!(
        states.1,
        r#"{"state":"pending","blocked_by":"memory_write_busy"}"#
    );
    assert_eq!(
        states.2,
        r#"{"state":"failed","code":"memory_vector_io_transient","retryable":false,"next_attempt_at":null}"#
    );
}
