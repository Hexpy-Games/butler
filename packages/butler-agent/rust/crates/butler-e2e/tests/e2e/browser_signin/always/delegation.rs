//! Run-now and unattended flags survive parent -> steward -> worker preparation.
use super::super::host::{admin, attach, snapshot, tab};
use super::{
    SITE, URL,
    schedules::{attention, create, run},
};
use axum::{Json, Router, extract::State, routing::post};
use butler_e2e::e2e::{
    HarnessError, cassette::Cassette, matching, sanitize::Placeholders, scenario::Setup,
};
use reqwest::Method;
use serde_json::{Value, json};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

#[tokio::test]
async fn every_schedule_descendant_keeps_both_browser_switches() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for payment in [false, true] {
        for scheduled in [false, true] {
            verify(payment, scheduled).await?;
        }
    }
    Ok(())
}

async fn verify(payment: bool, scheduled: bool) -> Result<(), HarnessError> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let endpoint = format!("http://{}/codex", listener.local_addr()?);
    let app = Router::new()
        .route("/codex/responses", post(reply))
        .with_state(payment);
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let s = Setup::new("SCHEDULE-DELEGATED-SWITCHES")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", endpoint)
        .start()
        .await?;
    let admin = admin(&s);
    let host = attach(&s, Arc::new(|frame: Value| Box::pin(async move {
        if frame["op"] == "tab.prepare" {
            json!({"status":"ok","tab":"identity","url":URL,"profile":"signed_in","obs":"o1",
                "steps":[{"action":"click","payment":true,"submit":true,"form_post":true,"hit":{"role":"button","name":"Pay","frame":""}}]})
        } else {
            json!({"status":"ok","tab":"identity","url":URL,"profile":"signed_in","obs":"o1","text":"Account"})
        }
    }))).await?;
    let grant = admin
        .send(
            Method::POST,
            "/security/signins/site",
            Some(json!({"site":SITE,"all_conversations":true})),
            &[],
        )
        .await?;
    assert_eq!(grant.status, 200, "{}", grant.text);
    let grant = admin
        .send(
            Method::POST,
            "/security/vault/purchase-sites",
            Some(json!({"site":SITE,"allow":true})),
            &[],
        )
        .await?;
    assert_eq!(grant.status, 200, "{}", grant.text);
    snapshot(
        &admin,
        json!([tab("identity", "conversation:general", URL, "agent")]),
    )
    .await?;
    let id = create(&s, scheduled, payment, !payment).await?;
    let initial = run(&s, &id, scheduled).await?;
    let code = if payment {
        "schedule_payment_off"
    } else {
        "schedule_signin_off"
    };
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let runs = s.gw.get(&format!("/automations/{id}/runs")).await?;
        let result = &runs.data()["runs"][0];
        if result["safe_error_code"] == code && contexts_ready(&s, &initial, payment, scheduled)? {
            attention(&s, result, Some(code)).await?;
            break;
        }
        assert!(
            Instant::now() < deadline,
            "descendant refusal or worker context missing: {result}\n{}",
            s.agent.logs()
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(
        !host
            .ops()
            .iter()
            .any(|op| matches!(op.as_str(), "tab.open" | "tab.act" | "pay.fill"))
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

fn contexts_ready(
    s: &butler_e2e::e2e::scenario::Scenario,
    run: &Value,
    payment: bool,
    scheduled: bool,
) -> Result<bool, HarnessError> {
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let mut stmt = db.prepare("SELECT context_json FROM btcc_turns")?;
    let values = stmt
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    let contexts: Vec<Value> = values
        .iter()
        .map(|text| serde_json::from_str(text).unwrap())
        .collect();
    let descendants: Vec<_> = contexts
        .iter()
        .filter_map(|c| c.get("scheduleRun"))
        .filter(|c| c["run_id"] == run["id"])
        .collect();
    if descendants.len() < 3 {
        return Ok(false);
    }
    for context in descendants {
        assert_eq!(context["automation_id"], run["automation_id"]);
        assert_eq!(context["unattended"], scheduled);
        assert_eq!(context["browser"]["signin"], payment);
        assert_eq!(context["browser"]["payment"], !payment);
    }
    Ok(true)
}

async fn reply(
    State(payment): State<bool>,
    Json(body): Json<Value>,
) -> impl axum::response::IntoResponse {
    let key = matching::key("/codex/responses", &body, &Placeholders::default());
    let step = key
        .round
        .iter()
        .filter(|k| k.as_str() == "function_call_output")
        .count();
    let worker = key.user_request.starts_with("role: worker");
    let steward = key.user_request.starts_with("role: steward")
        || body["instructions"]
            .as_str()
            .unwrap_or("")
            .contains("You run one delegated Work for Butler");
    // Worker mutation tools are outside its default surface. Exercise payment
    // refusal in the steward and still prepare a worker to check both flags.
    let call = if worker {
        if payment {
            None
        } else {
            match step {
                0 => Some(("tool_describe", json!({"ids":["native:browser_open"]}))),
                1 => Some((
                    "tool_call",
                    json!({"id":"native:browser_open","arguments":{"url":URL,"signed_in":true}}),
                )),
                _ => None,
            }
        }
    } else if steward && !key.user_request.starts_with("Delegated result") {
        match step {
            0 => Some((
                "replace_work_plan",
                json!({"objective":"Check account","execution_mode":"workers","actions":[{"action_key":"check","description":"Check account","dependency_keys":[]}],"checks":["Account checked"]}),
            )),
            1 => Some((
                "record_work_review",
                json!({"subject":"plan","verdict":"accept","summary":"Ready"}),
            )),
            2 if payment => Some(("tool_describe", json!({"ids":["native:browser_act"]}))),
            3 if payment => Some((
                "tool_call",
                json!({"id":"native:browser_act","arguments":{"tab":"identity","observation":"o1","steps":[{"action":"click","ref":"e1","commits":true}]}}),
            )),
            n if n == if payment { 4 } else { 2 } => Some((
                "delegate_to_worker",
                json!({"action_key":"check","objective":"Check account","acceptance_criteria":["Account checked"],"implementation_brief":"Check account","safe_title":"Check account"}),
            )),
            n if n == if payment { 5 } else { 3 } => Some(("wait_for_worker", json!({}))),
            _ => None,
        }
    } else if !steward && step == 0 && !key.user_request.starts_with("Delegated result") {
        Some((
            "delegate_to_steward",
            json!({"request":"Check account","checks":["Account checked"],"safe_title":"Check account"}),
        ))
    } else {
        None
    };
    let id = format!("schedule-{worker}-{steward}-{step}");
    let item = match call {
        Some((name, args)) => {
            json!({"type":"function_call","id":id,"call_id":id,"name":name,"arguments":args.to_string(),"status":"completed"})
        }
        None => {
            json!({"type":"message","id":id,"role":"assistant","status":"completed","content":[{"type":"output_text","text":"Done.","annotations":[]}]})
        }
    };
    let response = crate::browser_usage::stub::response(&item);
    (
        [("content-type", "text/event-stream")],
        response
            .chunks
            .into_iter()
            .map(|c| c.text)
            .collect::<String>(),
    )
}
