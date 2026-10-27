//! Board proposals use the same tier, exact approval and App create path as schedules.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "E2E assertions"
)]
mod stub;
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    gateway::turn_state,
    scenario::{Scenario, Setup, accepted_turn_id, turn_timeout},
};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};

type Started = (Scenario, Arc<stub::Script>, stub::Server, String, String);
async fn setup(mode: &str, kind: &str) -> Result<Started, HarnessError> {
    let (url, script, server) = stub::start().await?;
    let s = Setup::new("CANON-PROPOSE")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CHATGPT_API_BASE_URL", &url)
        .start()
        .await?;
    let reply =
        s.gw.post(
            "/projects",
            json!({"source":"scratch","display_name":"Board"}),
        )
        .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    let project = reply.data()["project"]["id"].as_str().unwrap().to_owned();
    let reply =
        s.gw.post(
            &format!("/projects/{project}/canon/plans"),
            json!({"title":"Milestone"}),
        )
        .await?;
    assert_eq!(reply.status, 201, "{}", reply.text);
    let plan = reply.data()["id"].as_str().unwrap().to_owned();
    let mut args = json!({"kind":kind,"project_ref":"Board","title":"Requested item","description":"Exact details"});
    if kind == "epic" {
        args["plan_id"] = plan.clone().into();
    } else {
        args["due_on"] = "2028-02-29".into();
    }
    *script.args.lock().unwrap() = args;
    let reply =
        s.gw.patch("/sessions/general/controls", json!({"access_mode":mode}))
            .await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok((s, script, server, project, plan))
}
async fn propose(s: &Scenario) -> Result<(String, Value), HarnessError> {
    let id = accepted_turn_id(&s.gw.say("general", "Create the board item.").await?)?;
    let turn =
        s.gw.wait_turn(
            "general",
            &id,
            &["waiting_for_form", "delivered", "failed"],
            Duration::from_secs(turn_timeout()),
        )
        .await?;
    Ok((id, turn))
}
async fn board(s: &Scenario, project: &str) -> Result<Value, HarnessError> {
    let reply = s.gw.get(&format!("/projects/{project}/canon")).await?;
    assert_eq!(reply.status, 200, "{}", reply.text);
    Ok(reply.data().clone())
}
fn epic_count(s: &Scenario) -> Result<i64, HarnessError> {
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    Ok(db.query_row("SELECT count(*) FROM canon_epics", [], |r| r.get(0))?)
}
fn result(script: &stub::Script) -> Value {
    script
        .outputs
        .lock()
        .unwrap()
        .iter()
        .find_map(|v| {
            if v.get("ref").is_some() {
                Some(v.clone())
            } else {
                v.get("output").filter(|v| v.get("ref").is_some()).cloned()
            }
        })
        .expect("model received canon ref")
}

#[tokio::test]
async fn ask_first_exact_epic_card_allow_and_replay_identity() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, _server, project, plan) = setup("ask_first", "epic").await?;
    let stream = butler_e2e::e2e::events::LiveEvents::subscribe(&s.gw, 0).await?;
    let (id, turn) = propose(&s).await?;
    assert_eq!(turn_state(&turn), "waiting_for_form", "{turn}");
    let requests = s.gw.approval_requests("general").await?;
    assert_eq!(requests.len(), 1, "{requests:?}");
    let request = &requests[0];
    assert_eq!(request["approval"]["action_kind"], "create_canon");
    assert_eq!(request["approval"]["risk"], "low");
    assert_eq!(
        request["approval"]["canon"],
        json!({"kind":"epic","title":"Requested item",
        "project_id":project,"project_title":"Board","plan_id":plan,"plan_title":"Milestone","description":"Exact details"})
    );
    assert_eq!(epic_count(&s)?, 0);
    // Renaming a plan while approval is pending must not alter the reviewed identity.
    let row = s.gw.get(&format!("/canon/plans/{plan}")).await?;
    let changed =
        s.gw.patch(
            &format!("/canon/plans/{plan}"),
            json!({"expected_revision":row.data()["revision"],"title":"Renamed milestone"}),
        )
        .await?;
    assert_eq!(changed.status, 200, "{}", changed.text);
    let reference = request["request_ref"].as_str().unwrap();
    let reply =
        s.gw.post(
            &format!("/authority-requests/{reference}/allow?session_id=general"),
            json!({"scope":"once"}),
        )
        .await?;
    assert_eq!(reply.status, 202, "{}", reply.text);
    let turn =
        s.gw.wait_terminal("general", &id, Duration::from_secs(turn_timeout()))
            .await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    assert_eq!(epic_count(&s)?, 1);
    let output = result(&script);
    assert_eq!(output["ok"], true);
    assert_eq!(output["project_id"], project);
    assert_eq!(output["title"], "Requested item");
    let epic = output["ref"]
        .as_str()
        .unwrap()
        .strip_prefix("canon:epic/")
        .unwrap();
    let row = s.gw.get(&format!("/canon/epics/{epic}")).await?;
    assert_eq!(row.status, 200, "{}", row.text);
    assert_eq!(row.data()["plan_id"], plan);
    assert_eq!(row.data()["description"], "Exact details");
    let page = board(&s, &project).await?;
    let group = page["plans"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == plan)
        .unwrap();
    assert_eq!(group["works"].as_array().unwrap().len(), 1);
    assert_eq!(group["works"][0]["id"], epic);
    stream
        .wait_for(Duration::from_secs(10), |e| {
            e["type"] == "canon.changed" && e["payload"]["id"] == epic
        })
        .await?;
    drop(stream);
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))?;
    let actor: String = db.query_row(
        "SELECT actor_json FROM canon_audit WHERE entity_id=?1 ORDER BY seq LIMIT 1",
        [epic],
        |r| r.get(0),
    )?;
    assert_eq!(
        serde_json::from_str::<Value>(&actor)?["person"],
        butler_gateway::gateway::APP_PERSON_ID
    );
    drop(db);
    s.finish().await
}

#[tokio::test]
async fn decline_creates_nothing() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, _server, project, _) = setup("ask_first", "epic").await?;
    let (id, turn) = propose(&s).await?;
    assert_eq!(turn_state(&turn), "waiting_for_form", "{turn}");
    let requests = s.gw.approval_requests("general").await?;
    let reference = requests[0]["request_ref"].as_str().unwrap();
    let reply =
        s.gw.post(
            &format!("/authority-requests/{reference}/deny?session_id=general"),
            json!({}),
        )
        .await?;
    assert_eq!(reply.status, 202, "{}", reply.text);
    let terminal =
        s.gw.wait_terminal("general", &id, Duration::from_secs(turn_timeout()))
            .await?;
    assert_eq!(
        turn_state(&terminal),
        "delivered",
        "{terminal}; outputs={:?}; errors={}",
        script.outputs.lock().unwrap(),
        s.agent
            .logs()
            .lines()
            .filter(|line| line.contains("interrupt") || line.contains("error"))
            .collect::<Vec<_>>()
            .join("\n")
    );
    assert_eq!(epic_count(&s)?, 0);
    board(&s, &project).await?;
    s.finish().await
}

#[tokio::test]
async fn full_and_auto_create_without_card() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for mode in ["full_access", "auto"] {
        let (s, script, _server, project, _) = setup(mode, "epic").await?;
        let (_, turn) = propose(&s).await?;
        assert_eq!(turn_state(&turn), "delivered", "{turn}");
        assert_eq!(s.gw.approval_requests("general").await?, [] as [Value; 0]);
        assert_eq!(epic_count(&s)?, 1);
        assert_eq!(result(&script)["project_id"], project);
        s.finish().await?;
    }
    Ok(())
}

#[tokio::test]
async fn read_only_refuses_without_card_or_create() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, _server, _, _) = setup("read_only", "epic").await?;
    let (_, turn) = propose(&s).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    assert_eq!(s.gw.approval_requests("general").await?, [] as [Value; 0]);
    assert_eq!(epic_count(&s)?, 0);
    assert!(
        !script
            .offered
            .lock()
            .unwrap()
            .iter()
            .any(|n| n == "canon_propose")
    );
    let outputs = script.outputs.lock().unwrap().clone();
    assert!(outputs.iter().any(|v| v["ok"] == false), "{outputs:?}");
    s.finish().await
}

#[tokio::test]
async fn plan_due_date_and_project_id_reference() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, _server, project, _) = setup("ask_first", "plan").await?;
    script.args.lock().unwrap()["project_ref"] = project.clone().into();
    let (id, turn) = propose(&s).await?;
    assert_eq!(turn_state(&turn), "waiting_for_form", "{turn}");
    let requests = s.gw.approval_requests("general").await?;
    assert_eq!(
        requests[0]["approval"]["canon"],
        json!({"kind":"plan","title":"Requested item",
        "project_id":project,"project_title":"Board","due_on":"2028-02-29","description":"Exact details"})
    );
    let reference = requests[0]["request_ref"].as_str().unwrap();
    let reply =
        s.gw.post(
            &format!("/authority-requests/{reference}/allow?session_id=general"),
            json!({"scope":"once"}),
        )
        .await?;
    assert_eq!(reply.status, 202, "{}", reply.text);
    let terminal =
        s.gw.wait_terminal("general", &id, Duration::from_secs(turn_timeout()))
            .await?;
    assert_eq!(turn_state(&terminal), "delivered", "{terminal}");
    let output = result(&script);
    let id = output["ref"]
        .as_str()
        .unwrap()
        .strip_prefix("canon:plan/")
        .unwrap();
    let row = s.gw.get(&format!("/canon/plans/{id}")).await?;
    assert_eq!(row.status, 200, "{}", row.text);
    assert_eq!(row.data()["due_on"], "2028-02-29");
    assert_eq!(row.data()["project_id"], project);
    s.finish().await
}

#[tokio::test]
async fn invalid_project_plan_and_due_date_are_recoverable() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    for (field, value, code) in [
        ("project_ref", "missing-project", "project_not_found"),
        ("plan_id", "missing-plan", "canon_plan_not_found"),
        ("due_on", "2027-02-29", "canon_propose_invalid"),
    ] {
        let kind = if field == "due_on" { "plan" } else { "epic" };
        let (s, script, _server, _, _) = setup("full_access", kind).await?;
        script.args.lock().unwrap()[field] = value.into();
        let (_, turn) = propose(&s).await?;
        assert_eq!(turn_state(&turn), "delivered", "{turn}");
        assert_eq!(epic_count(&s)?, 0);
        assert_eq!(s.gw.approval_requests("general").await?, [] as [Value; 0]);
        let outputs = script.outputs.lock().unwrap().clone();
        let failure = outputs
            .iter()
            .find(|v| v["error"]["code"] == code || v["output"]["error"]["code"] == code)
            .expect("recoverable tool error");
        let failure = failure.get("output").unwrap_or(failure);
        assert_eq!(failure["error"]["recoverable"], true, "{failure}");
        s.finish().await?;
    }
    Ok(())
}

#[tokio::test]
async fn project_lookup_is_indexed_and_cross_project_plan_is_rejected() -> Result<(), HarnessError>
{
    butler_e2e::gate!();
    let (s, script, _server, _, _) = setup("full_access", "epic").await?;
    let other =
        s.gw.post(
            "/projects",
            json!({"source":"scratch","display_name":"Other board"}),
        )
        .await?;
    assert_eq!(other.status, 201, "{}", other.text);
    let id = other.data()["project"]["id"].as_str().unwrap();
    let plan =
        s.gw.post(
            &format!("/projects/{id}/canon/plans"),
            json!({"title":"Other milestone"}),
        )
        .await?;
    assert_eq!(plan.status, 201, "{}", plan.text);
    script.args.lock().unwrap()["plan_id"] = plan.data()["id"].clone();
    let (_, turn) = propose(&s).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    assert_eq!(epic_count(&s)?, 0);
    let outputs = script.outputs.lock().unwrap().clone();
    assert!(
        outputs
            .iter()
            .any(|v| v["error"]["code"] == "canon_plan_not_found"
                || v["output"]["error"]["code"] == "canon_plan_not_found"),
        "{outputs:?}"
    );
    let db = rusqlite::Connection::open(s.sandbox.data.join("app-server/butler-client.sqlite"))?;
    let query: String = db.query_row("EXPLAIN QUERY PLAN SELECT id,display_name FROM projects INDEXED BY projects_active_name_idx WHERE display_name=?1 AND archived=0 LIMIT 2", ["Board"], |r| r.get(3))?;
    assert!(query.contains("projects_active_name_idx"), "{query}");
    drop(db);
    let renamed =
        s.gw.patch(&format!("/projects/{id}"), json!({"display_name":"Board"}))
            .await?;
    assert_eq!(renamed.status, 200, "{}", renamed.text);
    let ambiguous = s.gw.get("/projects?project_ref=Board").await?;
    assert_eq!(ambiguous.status, 409, "{}", ambiguous.text);
    assert_eq!(
        ambiguous.body["error"]["code"],
        "project_reference_ambiguous"
    );
    let exact = s.gw.get(&format!("/projects?project_ref={id}")).await?;
    assert_eq!(exact.status, 200, "{}", exact.text);
    assert_eq!(exact.data()["id"], id);
    s.finish().await
}

#[tokio::test]
async fn same_item_retry_in_one_run_replays_the_created_item() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, _server, project, _) = setup("auto", "epic").await?;
    script
        .retry
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let (_, turn) = propose(&s).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    assert_eq!(epic_count(&s)?, 1);
    let outputs = script.outputs.lock().unwrap().clone();
    let created: Vec<_> = outputs
        .iter()
        .map(|v| v.get("output").unwrap_or(v))
        .filter(|v| v.get("ref").is_some())
        .collect();
    assert_eq!(created.len(), 2, "{outputs:?}");
    assert_eq!(created[0]["ref"], created[1]["ref"]);
    assert_eq!(created[1]["effect_receipt"]["replayed"], true);
    assert_eq!(created[1]["project_id"], project);
    s.finish().await
}

#[tokio::test]
async fn non_string_description_is_recoverable_without_a_card_or_created_item()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, _server, _, _) = setup("ask_first", "epic").await?;
    script
        .direct
        .store(true, std::sync::atomic::Ordering::SeqCst);
    script.args.lock().unwrap()["description"] = json!({"text":"Invalid details"});
    let (_, turn) = propose(&s).await?;
    assert_eq!(turn_state(&turn), "delivered", "{turn}");
    assert_eq!(s.gw.approval_requests("general").await?, [] as [Value; 0]);
    assert_eq!(epic_count(&s)?, 0);
    let outputs = script.outputs.lock().unwrap().clone();
    assert!(
        outputs
            .iter()
            .any(|v| v["error"]["code"] == "canon_propose_invalid"
                || v["output"]["error"]["code"] == "canon_propose_invalid"),
        "{outputs:?}"
    );
    s.finish().await
}
