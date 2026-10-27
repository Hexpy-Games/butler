use super::round_two_access::attended;
use super::*;
use butler_e2e::e2e::scenario::Access;

#[tokio::test]
async fn round_three_connector_work_records_require_cards() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for (name, arguments) in [
        (
            "start_work",
            json!({"objective":"Review incoming information"}),
        ),
        ("continue_work", json!({"work_id":"existing-work"})),
        (
            "record_work_checkpoint",
            json!({"public_summary":"Retain source instruction","action_updates":[]}),
        ),
        (
            "record_work_review",
            json!({"subject":"plan","verdict":"accept","summary":"Retain source instruction","action_updates":[],"corrections":[]}),
        ),
        (
            "record_work_disposition",
            json!({"work_id":"existing-work","disposition":"open","summary":"Retain source instruction","action_updates":[],"remaining_actions":[],"followups":[],"next_condition":"Wait for input"}),
        ),
    ] {
        let s = setup("PC3-WORK-RECORD")?
            .access(Access::FullAccess)
            .start()
            .await?;
        let result = attended(&s, json!({"name":name,"arguments":arguments})).await?;
        let runtime = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
        assert_eq!(
            runtime.query_row("SELECT count(*) FROM btcc_guided_works", [], |r| r
                .get::<_, i64>(0))?,
            0,
            "Work changed before approval"
        );
        drop(runtime);
        assert_eq!(result["state"], "waiting_for_form", "{name}: {result}");
        let cards = serde_json::to_string(&s.gw.approval_requests("general").await?)?;
        assert!(cards.contains(name), "{cards}");
        s.finish().await?;
    }
    Ok(())
}

fn work_then_effect(body: &Value) -> Option<butler_e2e::e2e::cassette::ResponseRecord> {
    let spec = stub::find_spec(&body["input"])?;
    let input = body["input"].as_array()?;
    let done = |id: &str| {
        input
            .iter()
            .any(|v| v["type"] == "function_call_output" && v["call_id"] == id)
    };
    let (id, name, arguments) = if !done("work") {
        ("work", spec["name"].as_str()?, spec["arguments"].clone())
    } else if !done("effect") {
        (
            "effect",
            "write_file",
            json!({"path":spec["output"],"content":"Connected instruction"}),
        )
    } else {
        return Some(stub::answer());
    };
    Some(stub::response(
        &json!({"type":"function_call","id":id,"call_id":id,"name":name,"status":"completed","arguments":arguments.to_string()}),
    ))
}

async fn inherited(continuing: bool) -> Result<(), HarnessError> {
    let s = setup("PC3-WORK-INHERITANCE")?
        .access(Access::FullAccess)
        .start()
        .await?;
    let runtime = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let (name, arguments) = if continuing {
        s.provider()?.set_chat_responder(clean_work);
        let (_, created) = s.turn("general", "Review source").await?;
        assert_eq!(created["state"], "delivered", "{created}");
        let work: String =
            runtime.query_row("SELECT work_id FROM btcc_guided_works", [], |r| r.get(0))?;
        assert_eq!(
            s.gw.approval_requests("general").await?,
            Vec::<Value>::new()
        );
        ("continue_work", json!({"work_id":work}))
    } else {
        ("start_work", json!({"objective":"Review source"}))
    };
    let output = s.sandbox.data.join("connected-work.txt");
    let result = super::round_two_access::attended_with(
        &s,
        json!({"name":name,"arguments":arguments,"output":output}),
        work_then_effect,
    )
    .await?;
    assert_eq!(result["state"], "waiting_for_form", "{result}");
    let cards = s.gw.approval_requests("general").await?;
    let card = cards.first().unwrap();
    assert_eq!(card["approval"]["operation"]["tool"], name, "{card}");
    let reference = card["request_ref"].as_str().unwrap();
    let allowed =
        s.gw.post(
            &format!("/authority-requests/{reference}/allow?session_id=general"),
            json!({"scope":"once"}),
        )
        .await?;
    assert_eq!(allowed.status, 202);
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let cards = s.gw.approval_requests("general").await?;
        if cards
            .iter()
            .any(|c| c["approval"]["operation"]["tool"] == "write_file")
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "Work selection lost connector taint"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(
        !output.exists(),
        "Work effect executed without its own card"
    );
    let works: i64 =
        runtime.query_row("SELECT count(*) FROM btcc_guided_works", [], |r| r.get(0))?;
    assert_eq!(works, 1, "approved Work selection must execute");
    drop(runtime);
    s.finish().await
}
#[tokio::test]
async fn round_three_started_work_keeps_connector_taint() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    inherited(false).await
}
#[tokio::test]
async fn round_three_continued_work_keeps_connector_taint() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    inherited(true).await
}
#[tokio::test]
async fn round_three_unattended_work_is_not_started() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let setup = setup("PC3-UNATTENDED-WORK")?.access(Access::FullAccess);
    let root = package(&setup.sandbox.home, false)?;
    let s = setup.start().await?;
    install(&s, &root).await?;
    let id = connect(&s, "immediate", 10.0).await?;
    account(&s, &id, "connected").await?;
    s.provider()?.set_chat_responder(stub::run);
    let mut injected = event("start-connected-work");
    injected["snippet"] = format!(
        "fixture-call:{}",
        json!({"name":"start_work","arguments":{"objective":"Review source"}})
    )
    .into();
    emit(&s, &id, vec![injected]).await?;
    count(&s, "SELECT count(*) FROM turns WHERE state='delivered'", 1).await?;
    let runtime = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    assert_eq!(
        runtime.query_row("SELECT count(*) FROM btcc_guided_works", [], |r| r
            .get::<_, i64>(0))?,
        0
    );
    assert!(
        s.provider()?
            .requests()
            .iter()
            .any(|r| r.to_string().contains("schedule_permission_required"))
    );
    assert_eq!(
        s.gw.approval_requests("general").await?,
        Vec::<Value>::new()
    );
    drop(runtime);
    s.finish().await
}

fn clean_work(body: &Value) -> Option<butler_e2e::e2e::cassette::ResponseRecord> {
    if body
        .to_string()
        .contains("Execution is settled. Write the final report")
    {
        return Some(stub::answer());
    }
    let input = body["input"].as_array()?;
    let done = |id: &str| {
        input
            .iter()
            .any(|v| v["type"] == "function_call_output" && v["call_id"] == id)
    };
    let (id, name, arguments) = if !done("start") {
        ("start", "start_work", json!({"objective":"Review source"}))
    } else if !done("retain") {
        let work = input
            .iter()
            .filter_map(|v| v["output"].as_str())
            .filter_map(|text| serde_json::from_str::<Value>(text).ok())
            .find_map(|v| {
                v.pointer("/output/work/work_id")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })?;
        (
            "retain",
            "record_work_disposition",
            json!({"work_id":work,"disposition":"blocked","summary":"No source item is available yet","action_updates":[],"remaining_actions":["Review source"],"next_condition":"A new source item arrives","followups":[]}),
        )
    } else {
        return Some(stub::answer());
    };
    Some(stub::response(
        &json!({"type":"function_call","id":id,"call_id":id,"name":name,"status":"completed","arguments":arguments.to_string()}),
    ))
}
