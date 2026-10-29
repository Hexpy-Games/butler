use super::*;
use butler_platform::sqlite;
use rusqlite::params;

pub(super) async fn assert_followup(
    s: &Scenario,
    script: &stub::Script,
    q: &Value,
) -> Result<(), HarnessError> {
    let mut questions = crate::ask_user::stub::questions();
    questions.sort_all_objects();
    let mut answer = crate::ask_user::answer();
    answer.sort_all_objects();
    let expected = format!("Answers to your deferred questions:\n{questions}\n{answer}");
    let data = s.sandbox.data.clone();
    let query_text = expected.clone();
    let (text, turn): (String, Option<String>) = tokio::task::spawn_blocking(move || {
        let db = sqlite::open(data.join("app-server/butler-client.sqlite"))?;
        Ok::<_, HarnessError>(db.query_row(
            "SELECT text,turn_id FROM session_queued_messages WHERE chat_id='general' AND text=?1",
            [query_text],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?)
    })
    .await
    .map_err(|e| HarnessError(e.to_string()))??;
    assert_eq!(text, expected);
    if let Some(turn) = turn {
        s.gw.wait_terminal("general", &turn, Duration::from_secs(20))
            .await?;
    }
    let requests = script.requests.lock().unwrap();
    let output = requests
        .iter()
        .flat_map(|r| r["input"].as_array().unwrap())
        .find(|item| item["type"] == "function_call_output" && item["call_id"] == "call_ask")
        .unwrap();
    let result: Value = serde_json::from_str(output["output"].as_str().unwrap())?;
    assert_eq!(
        result,
        json!({"ok":true,"output":{"tool_name":"ask_user","ok":true,"open":true,"ask_id":q["ask_id"],"message":"The question is now an open card the user can answer any time. Finish your reply without the answer and without repeating the question; its answer will arrive as a later message."}})
    );
    Ok(())
}

#[tokio::test]
async fn pa_07_stopping_a_later_turn_preserves_an_answerable_question() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (s, _, server) = setup("PA-07").await?;
    let q = ask(&s, "general").await?;
    let id = s.gw.say_turn("general", stub::APPROVE).await?;
    s.gw.wait_turn(
        "general",
        &id,
        &["waiting_for_form"],
        Duration::from_secs(20),
    )
    .await?;
    let cancel = s.gw.post(&format!("/turns/{id}/cancel"), json!({})).await?;
    assert_eq!(cancel.status, 202, "{cancel:?}");
    s.gw.wait_terminal("general", &id, Duration::from_secs(20))
        .await?;
    assert_eq!(asks(&s, "general").await?["asks"], json!([q]));
    let reference = q["ask_id"]
        .as_str()
        .unwrap()
        .strip_prefix("question:")
        .unwrap();
    let answer =
        s.gw.post(
            &format!("/authority-requests/{reference}/answer?session_id=general"),
            crate::ask_user::answer(),
        )
        .await?;
    assert_eq!(answer.status, 202, "{answer:?}");
    assert_eq!(asks(&s, "general").await?["open_count"], 0);
    server.abort();
    s.finish().await
}

#[tokio::test]
async fn pa_08_answered_blocking_history_is_outside_the_open_index() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, _, server) = setup("PA-08").await?;
    let q = ask(&s, "general").await?;
    let data = s.sandbox.data.clone();
    let reference = q["ask_id"]
        .as_str()
        .unwrap()
        .strip_prefix("question:")
        .unwrap()
        .to_owned();
    tokio::task::spawn_blocking(move || history(&data, &reference))
        .await
        .map_err(|e| HarnessError(e.to_string()))??;
    let all = s.gw.get("/pending-asks").await?;
    assert_eq!(all.data()["asks"].as_array().unwrap().len(), 1);
    assert_eq!(all.data()["asks"][0]["ask_id"], q["ask_id"]);
    server.abort();
    s.finish().await
}
fn history(data: &std::path::Path, reference: &str) -> Result<(), HarnessError> {
    let db = sqlite::open(data.join("agent-runtime/btcc.sqlite"))?;
    let names = db
        .prepare("PRAGMA table_info(btcc_authority_requests)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    let values = names
        .iter()
        .map(|name| match name.as_str() {
            "request_id"
            | "request_ref"
            | "identity_sha256"
            | "schedule_client_message_id"
            | "action_key"
            | "source_turn_id" => "'answered-'||n.i".into(),
            "private_alternative_input" => "?2".into(),
            "outcome_receipt_json" => "NULL".into(),
            _ => format!("r.{name}"),
        })
        .collect::<Vec<String>>();
    db.execute(&format!("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<50) INSERT INTO btcc_authority_requests ({}) SELECT {} FROM n,btcc_authority_requests r WHERE r.request_ref=?1", names.join(","),values.join(",")),params![reference,crate::ask_user::answer().to_string()])?;
    for (page, (sql, _)) in butler_turn::btcc::storage::pending_ask_plan_statements()
        .into_iter()
        .take(2)
        .enumerate()
    {
        super::queries::assert_index(&db, &sql, "idx_btcc_authority_open_v2")?;
        if page == 0 {
            let mut statement = db.prepare(&sql)?;
            let rows = statement
                .query_map([200], |r| r.get::<_, String>(1))?
                .collect::<Result<Vec<_>, _>>()?;
            assert_eq!(rows, [reference]);
        }

        let ddl: String = db.query_row(
            "SELECT sql FROM sqlite_master WHERE name='idx_btcc_authority_open_v2'",
            [],
            |r| r.get(0),
        )?;
        let filter = ddl.split_once("WHERE ").unwrap().1;
        let count: i64 = db.query_row(&format!("SELECT COUNT(*) FROM btcc_authority_requests INDEXED BY idx_btcc_authority_open_v2 WHERE {filter}"), [], |r| r.get(0))?;
        assert_eq!(
            count, 1,
            "answered blocking rows must not enter the partial index"
        );
    }
    eprintln!("PA-HISTORY: 50 answered blocking rows + 1 open; partial index contains exactly 1");
    Ok(())
}

#[tokio::test]
async fn pa_10_later_answer_sets_the_deferred_waiting_time() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, _, server) = setup("PA-10").await?;
    let id = s.gw.say_turn("general", stub::BLOCK).await?;
    s.gw.wait_turn(
        "general",
        &id,
        &["waiting_for_form"],
        Duration::from_secs(20),
    )
    .await?;
    let before = asks(&s, "general").await?["asks"][0].clone();
    assert_eq!(before["deferred"], false);
    assert_eq!(before["waiting_since"], before["created_at"]);
    let reference = before["ask_id"]
        .as_str()
        .unwrap()
        .strip_prefix("question:")
        .unwrap();
    let response =
        s.gw.post(
            &format!("/authority-requests/{reference}/answer?session_id=general"),
            json!({"status":"deferred"}),
        )
        .await?;
    assert_eq!(response.status, 202, "{response:?}");
    s.gw.wait_terminal("general", &id, Duration::from_secs(20))
        .await?;
    let after = asks(&s, "general").await?["asks"][0].clone();
    assert_fields(&s, "general", &after, true, Some("ask_user")).await?;
    assert!(after["waiting_since"].as_str().unwrap() > before["waiting_since"].as_str().unwrap());
    let data = s.sandbox.data.clone();
    let reference = reference.to_owned();
    let updated: String = tokio::task::spawn_blocking(move || {
        let db = sqlite::open(data.join("agent-runtime/btcc.sqlite"))?;
        Ok::<_, HarnessError>(db.query_row(
            "SELECT updated_at FROM btcc_authority_requests WHERE request_ref=?1",
            [reference],
            |r| r.get(0),
        )?)
    })
    .await
    .map_err(|e| HarnessError(e.to_string()))??;
    assert_eq!(after["waiting_since"], updated);
    server.abort();
    s.finish().await
}
