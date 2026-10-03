//! Settled authority history must not add work to a visible question poll.
use super::{HarnessError, Scenario, Value, answer};
use butler_platform::sqlite;
use rusqlite::{Connection, params};

const HISTORY: i64 = 10_000;

fn seed(db: &Connection, request_ref: &str) {
    let mut columns = db
        .prepare("PRAGMA table_info(btcc_authority_requests)")
        .unwrap();
    let names = columns
        .query_map([], |r| r.get::<_, String>(1))
        .unwrap()
        .map(Result::unwrap)
        .collect::<Vec<_>>();
    let values = names
        .iter()
        .map(|name| match name.as_str() {
            "request_id"
            | "request_ref"
            | "identity_sha256"
            | "schedule_client_message_id"
            | "action_key"
            | "source_turn_id" => "'history-'||n.i".into(),
            "decision" => "'modified'".into(),
            "outcome" => "'applied'".into(),
            "private_alternative_input" | "outcome_receipt_json" => "?2".into(),
            _ => format!("r.{name}"),
        })
        .collect::<Vec<String>>();
    db.execute(
        &format!(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<{HISTORY})
         INSERT INTO btcc_authority_requests ({}) SELECT {} FROM n,
         btcc_authority_requests r WHERE r.request_ref=?1",
            names.join(","),
            values.join(",")
        ),
        params![request_ref, answer().to_string()],
    )
    .unwrap();
    db.execute(
        &format!(
            "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<{HISTORY})
         INSERT INTO btcc_conversation_permissions
         SELECT 'history-grant-'||i,r.owner_session_id,'','history-scope-'||i,
         'Historical permission',printf('%02048d',i),r.created_at,NULL
         FROM n,btcc_authority_requests r WHERE r.request_ref=?1"
        ),
        [request_ref],
    )
    .unwrap();
    let counts: (i64, i64) = db
        .query_row(
            "SELECT (SELECT COUNT(*) FROM btcc_authority_requests),
                (SELECT COUNT(*) FROM btcc_conversation_permissions)",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(counts, (HISTORY + 1, HISTORY));
}

fn assert_pending_question_lookup_is_indexed(db: &Connection) {
    let mut statement = db
        .prepare(
            "EXPLAIN QUERY PLAN
             SELECT request_ref FROM btcc_authority_requests
             WHERE owner_session_id='general' AND close_reason IS NULL
               AND decision='pending' AND source_call_id IS NOT NULL
               AND EXISTS (SELECT 1 FROM btcc_turns turn
                 WHERE turn.turn_id=btcc_authority_requests.source_turn_id
                   AND turn.suspension_reason='authority_pending')
             UNION ALL
             SELECT request_ref FROM btcc_authority_requests
               INDEXED BY idx_btcc_questions_deferred
             WHERE owner_session_id='general' AND capability='ask_user'
               AND decision='modified' AND close_reason IS NULL
               AND outcome_receipt_json IS NULL
               AND json_extract(CASE WHEN capability='ask_user'
                 THEN private_alternative_input END,'$.status')='deferred'",
        )
        .unwrap();
    let plan = statement
        .query_map([], |row| row.get::<_, String>(3))
        .unwrap()
        .map(Result::unwrap)
        .collect::<Vec<_>>();
    assert!(
        plan.iter()
            .any(|detail| detail.contains("idx_btcc_authority_requests_owner_pending")),
        "pending authority lookup did not use its owner index: {plan:?}"
    );
    assert!(
        plan.iter()
            .any(|detail| detail.contains("idx_btcc_questions_deferred")),
        "deferred question lookup did not use its partial index: {plan:?}"
    );
    assert!(
        plan.iter()
            .all(|detail| !detail.contains("SCAN btcc_authority_requests")),
        "pending-question lookup scans authority history: {plan:?}"
    );
}

pub(crate) async fn seed_history(s: &Scenario, question: &Value) -> Result<(), HarnessError> {
    let data = s.sandbox.data.clone();
    let request_ref = question["request_ref"].as_str().unwrap().to_owned();
    tokio::task::spawn_blocking(move || {
        let db = sqlite::open(data.join("agent-runtime/btcc.sqlite")).unwrap();
        seed(&db, &request_ref);
        assert_pending_question_lookup_is_indexed(&db);
    })
    .await
    .map_err(|e| HarnessError(e.to_string()))?;
    Ok(())
}
