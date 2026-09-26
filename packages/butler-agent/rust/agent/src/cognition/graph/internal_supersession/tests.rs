
use rusqlite::Connection;

use super::{InternalSupersessionInput, supersede};

fn graph() -> Connection {
    let connection = Connection::open_in_memory().unwrap();
    connection
            .execute_batch(
                "CREATE TABLE memory_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);\
                 INSERT INTO memory_state VALUES('graph_revision','8');\
                 CREATE TABLE memory_chunks(memory_chunk_id TEXT PRIMARY KEY,current_revision TEXT,status TEXT,origin_kind TEXT);\
                 CREATE TABLE memory_chunk_sources(source_id TEXT PRIMARY KEY,episode_id TEXT,conversation_message_id TEXT,source_kind TEXT,role TEXT,origin_kind TEXT);\
                 CREATE TABLE memory_evidence(node_id TEXT,source_id TEXT,episode_id TEXT,revision TEXT);\
                 CREATE TABLE memory_claims(node_id TEXT PRIMARY KEY,source_class TEXT);",
            )
            .unwrap();
    connection
}

#[test]
fn supersession_marks_only_canonical_sources_recomputes_claims_and_bumps_once() {
    let mut connection = graph();
    connection
            .execute_batch(
                "INSERT INTO memory_chunks VALUES('episode','revision','active','assistant_public');\
                 INSERT INTO memory_chunk_sources VALUES\
                   ('request','episode','request-message','conversation','user','user_input'),\
                   ('assistant','episode','assistant-message','conversation','assistant','assistant_public'),\
                   ('other','episode','other-message','conversation','user','user_input');\
                 INSERT INTO memory_evidence VALUES\
                   ('claim-a','request','episode','revision'),\
                   ('claim-a','assistant','episode','revision'),\
                   ('claim-b','other','episode','revision');\
                 INSERT INTO memory_claims VALUES('claim-a','mixed'),('claim-b','user');",
            )
            .unwrap();

    supersede(
        &mut connection,
        InternalSupersessionInput {
            episode_id: "episode",
            internal_control_message_ids: &["request-message", "assistant-message"],
        },
    )
    .unwrap();

    let chunk: (String, String) = connection
        .query_row(
            "SELECT status,origin_kind FROM memory_chunks WHERE memory_chunk_id='episode'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(chunk, ("superseded".into(), "internal_control".into()));
    let mut statement = connection
            .prepare("SELECT conversation_message_id,origin_kind FROM memory_chunk_sources ORDER BY source_id")
            .unwrap();
    let origins = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    drop(statement);
    assert_eq!(
        origins,
        vec![
            ("assistant-message".into(), "internal_control".into()),
            ("other-message".into(), "user_input".into()),
            ("request-message".into(), "internal_control".into()),
        ]
    );
    let mut statement = connection
        .prepare("SELECT node_id,source_class FROM memory_claims ORDER BY node_id")
        .unwrap();
    let claims: Vec<(String, String)> = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    drop(statement);
    assert_eq!(
        claims,
        vec![
            ("claim-a".into(), "unknown".into()),
            ("claim-b".into(), "user".into())
        ]
    );
    let revision: String = connection
        .query_row(
            "SELECT value FROM memory_state WHERE key='graph_revision'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(revision, "9");

    supersede(
        &mut connection,
        InternalSupersessionInput {
            episode_id: "episode",
            internal_control_message_ids: &["request-message", "assistant-message"],
        },
    )
    .unwrap();
    let revision: String = connection
        .query_row(
            "SELECT value FROM memory_state WHERE key='graph_revision'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(revision, "9");
}

#[test]
fn supersession_of_an_absent_episode_is_a_noop() {
    let mut connection = graph();
    supersede(
        &mut connection,
        InternalSupersessionInput {
            episode_id: "missing",
            internal_control_message_ids: &["message"],
        },
    )
    .unwrap();
    let revision: String = connection
        .query_row(
            "SELECT value FROM memory_state WHERE key='graph_revision'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(revision, "8");
}
