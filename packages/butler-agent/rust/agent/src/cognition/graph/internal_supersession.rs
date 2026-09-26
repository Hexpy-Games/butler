//! Retire a public turn projection after its canonical request is classified as internal control.

use std::collections::HashSet;

use rusqlite::{Connection, params};

use super::{GraphRepository, db_error};
use crate::cognition::CognitionResult;

pub(in crate::cognition) struct InternalSupersessionInput<'a> {
    pub episode_id: &'a str,
    pub internal_control_message_ids: &'a [&'a str],
}

impl GraphRepository {
    pub(in crate::cognition) fn supersede_internal_projection(
        &mut self,
        input: InternalSupersessionInput<'_>,
    ) -> CognitionResult<()> {
        supersede(self.connection_mut()?, input)
    }
}

fn supersede(
    connection: &mut Connection,
    input: InternalSupersessionInput<'_>,
) -> CognitionResult<()> {
    let transaction = connection.transaction().map_err(db_error)?;
    let mut changed = transaction
        .execute(
            "UPDATE memory_chunks SET status='superseded',origin_kind='internal_control' \
             WHERE memory_chunk_id=?1 AND status='active'",
            [input.episode_id],
        )
        .map_err(db_error)?;

    for message_id in input.internal_control_message_ids {
        changed += transaction
            .execute(
                "UPDATE memory_chunk_sources SET origin_kind='internal_control' \
                 WHERE episode_id=?1 AND conversation_message_id=?2 AND origin_kind!='internal_control'",
                params![input.episode_id, message_id],
            )
            .map_err(db_error)?;
    }

    let affected_claims = {
        let mut statement = transaction
            .prepare(
                "SELECT DISTINCT evidence.node_id FROM memory_evidence evidence \
                 JOIN memory_claims claim ON claim.node_id=evidence.node_id \
                 WHERE evidence.episode_id=?1 ORDER BY evidence.node_id",
            )
            .map_err(db_error)?;
        statement
            .query_map([input.episode_id], |row| row.get::<_, String>(0))
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?
    };
    for node_id in affected_claims {
        let source_class = source_class(&transaction, &node_id)?;
        changed += transaction
            .execute(
                "UPDATE memory_claims SET source_class=?1 WHERE node_id=?2 AND source_class!=?1",
                params![source_class, node_id],
            )
            .map_err(db_error)?;
    }

    if changed > 0 {
        transaction
            .execute(
                "UPDATE memory_state SET value=CAST(value AS INTEGER)+1 WHERE key='graph_revision'",
                [],
            )
            .map_err(db_error)?;
    }
    transaction.commit().map_err(db_error)
}

fn source_class(connection: &Connection, node_id: &str) -> CognitionResult<&'static str> {
    let mut statement = connection
        .prepare(
            "SELECT source.role,source.source_kind,source.origin_kind \
             FROM memory_evidence evidence \
             JOIN memory_chunk_sources source ON source.source_id=evidence.source_id \
             WHERE evidence.node_id=?1 ORDER BY source.source_id",
        )
        .map_err(db_error)?;
    let classes = statement
        .query_map([node_id], |row| {
            let role = row.get::<_, String>(0)?;
            let source_kind = row.get::<_, String>(1)?;
            let origin_kind = row.get::<_, String>(2)?;
            Ok(classify_source(&role, &source_kind, &origin_kind))
        })
        .map_err(db_error)?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(db_error)?;
    Ok(if classes.len() > 1 {
        "mixed"
    } else {
        classes.into_iter().next().unwrap_or("unknown")
    })
}

fn classify_source(role: &str, source_kind: &str, origin_kind: &str) -> &'static str {
    if source_kind == "task_report" {
        "task_report"
    } else if source_kind == "explicit_record" {
        "explicit"
    } else if role == "user" && origin_kind == "user_input" {
        "user"
    } else if role == "assistant" && origin_kind == "assistant_public" {
        "assistant"
    } else {
        "unknown"
    }
}

#[cfg(test)]
mod tests {
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
}
