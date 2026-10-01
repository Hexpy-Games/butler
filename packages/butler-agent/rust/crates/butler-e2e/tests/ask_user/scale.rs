//! Settled authority history must not add work to a visible question poll.
use super::{HarnessError, Scenario, Value, answer, json};
use rusqlite::{Connection, params};
use std::time::{Duration, Instant};

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

pub(super) async fn assert_projection(s: &Scenario, question: &Value) -> Result<(), HarnessError> {
    let data = s.sandbox.data.clone();
    let request_ref = question["request_ref"].as_str().unwrap().to_owned();
    tokio::task::spawn_blocking(move || {
        seed(
            &Connection::open(data.join("agent-runtime/btcc.sqlite")).unwrap(),
            &request_ref,
        );
    })
    .await
    .map_err(|e| HarnessError(e.to_string()))?;
    let mut samples = Vec::new();
    for _ in 0..20 {
        let start = Instant::now();
        let view = s.gw.get("/session-view?session_id=general").await?;
        samples.push(start.elapsed());
        assert_eq!(view.status, 200, "{}", view.text);
        assert_eq!(view.data()["pending_questions"], json!([question]));
        assert_eq!(view.data()["question_answers"], json!([]));
        assert_eq!(view.data()["authority_requests"], json!([]));
        assert_eq!(view.data()["active_turn"]["id"], question["source_turn_id"]);
        assert_eq!(view.data()["latest_turn"]["state"], "waiting_for_form");
    }
    samples.sort();
    eprintln!(
        "ask_user authority_history={HISTORY} permissions={HISTORY} complete_pending_questions=1 session-view p50 {:?}; p95 {:?}",
        samples[9], samples[18]
    );
    assert!(
        samples[18] < Duration::from_millis(150),
        "session-view p95 {:?}",
        samples[18]
    );
    Ok(())
}
