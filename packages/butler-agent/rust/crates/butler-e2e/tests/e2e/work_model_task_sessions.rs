//! WMU-19/20/21 through scripted model turns, public routes and App projection.
#![allow(clippy::unwrap_used, clippy::expect_used, reason = "E2E assertions")]
mod canon;
mod stub;
#[path = "../../../butler-agent/src/host/guided/tools/work_model/ownership/sql.rs"]
mod title_sql;
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Scenario, Setup},
};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
const PLAN: &str = "Plan three pieces, each in its own conversation.";
const HERE: &str = "Plan three pieces and do them here.";
const TAKE: &str = "Continue that piece in this conversation.";

async fn start(
    id: &str,
) -> Result<
    (
        Scenario,
        std::sync::Arc<stub::Script>,
        tokio::task::JoinHandle<()>,
    ),
    HarnessError,
> {
    let (url, script, server) = stub::start().await?;
    let s = Setup::new(id)?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", url)
        .start()
        .await?;
    Ok((s, script, server))
}
async fn tasks(s: &Scenario) -> Result<Vec<Value>, HarnessError> {
    tasks_for(s, "general").await
}
async fn tasks_for(s: &Scenario, chat: &str) -> Result<Vec<Value>, HarnessError> {
    let reply = s.gw.get(&format!("/sessions/{chat}/works")).await?;
    assert_eq!(reply.status, 200, "{reply:?}");
    Ok(reply.data()["works"][0]["tasks"]["chains"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|chain| chain["steps"].as_array().unwrap())
        .flat_map(|step| step["tasks"].as_array().unwrap())
        .cloned()
        .collect())
}
async fn app_rows(s: &Scenario) -> Result<Vec<Value>, HarnessError> {
    let path = s.sandbox.data.join("app-server/butler-client.sqlite");
    tokio::task::spawn_blocking(move || {
        let db=rusqlite::Connection::open(path)?;
        db.prepare("SELECT t.task_id,t.session_id,EXISTS(SELECT 1 FROM app_space_nodes n WHERE n.node_key='s:'||t.session_id) FROM app_task_sessions t ORDER BY task_id")?
            .query_map([],|r|Ok(json!({"task":r.get::<_,String>(0)?,"session":r.get::<_,String>(1)?,"tree":r.get::<_,bool>(2)?})))?.collect::<rusqlite::Result<Vec<_>>>()
    }).await.unwrap().map_err(Into::into)
}
#[tokio::test]
async fn wmu_19_reservations_open_on_demand_and_nest_in_task_order() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server) = start("WMU-19").await?;
    let created =
        s.gw.post("/sessions", json!({"kind":"chat","title":"Three pieces"}))
            .await?;
    let chat = created.data()["session"]["id"].as_str().unwrap().to_owned();
    s.turn(&chat, PLAN).await?;
    tokio::time::timeout(Duration::from_secs(30), script.child_ready.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    let rows = tasks_for(&s, &chat).await?;
    assert_eq!(rows.len(), 3);
    assert_eq!(
        rows.iter()
            .map(|t| t["title"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["초안", "검토", "보고"]
    );
    assert_eq!(rows[0]["owner_epoch"], 1);
    for task in &rows[1..] {
        assert!(task["reserved_session_id"].is_string());
        assert!(task["assignee_session_id"].is_null());
    }
    let requester =
        s.gw.post("/sessions", json!({"kind":"chat","title":"Review here"}))
            .await?;
    let requester = requester.data()["session"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    *script.task.lock().unwrap() = rows[1]["id"].as_str().unwrap().to_owned();
    s.turn(&requester, TAKE).await?;
    let decision = ownership_result(&script);
    assert_eq!(decision["state"], "reserved", "{decision:?}");
    assert!(
        decision["message"]
            .as_str()
            .unwrap()
            .contains("its own conversation")
    );
    assert_eq!(
        app_rows(&s).await?.len(),
        1,
        "A card alone must not project a reserved chat"
    );
    let opened =
        s.gw.post(
            &format!("/tasks/{}/session", rows[1]["id"].as_str().unwrap()),
            json!({}),
        )
        .await?;
    assert_eq!(opened.status, 200, "{opened:?}");
    assert_eq!(opened.data()["session_id"], rows[1]["reserved_session_id"]);
    let again =
        s.gw.post(
            &format!("/tasks/{}/session", rows[1]["id"].as_str().unwrap()),
            json!({}),
        )
        .await?;
    assert_eq!(again.data(), opened.data());
    let chats = app_rows(&s).await?;
    assert_eq!(chats.len(), 2, "{chats:?}");
    assert!(chats.iter().all(|r| r["tree"] == false));
    app_query_plans(&s).await?;
    let navigation = s.gw.get("/navigation").await?;
    assert_eq!(navigation.status, 200, "{navigation:?}");
    let space = &navigation.data()["space"];
    let coordinator = space["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["entityId"] == chat)
        .unwrap();
    let nested = coordinator["task_sessions"].as_array().unwrap();
    assert_eq!(
        nested
            .iter()
            .map(|r| r["task_id"].clone())
            .collect::<Vec<_>>(),
        rows[..2]
            .iter()
            .map(|r| r["id"].clone())
            .collect::<Vec<_>>()
    );
    script.release.add_permits(4);
    s.finish().await?;
    server.abort();
    Ok(())
}
#[tokio::test]
async fn wmu_21_run_here_uses_the_current_conversation_only() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server) = start("WMU-21").await?;
    s.turn("general", HERE).await?;
    let rows = tasks(&s).await?;
    assert_eq!(rows.len(), 3);
    assert!(
        rows.iter()
            .all(|r| r["assignee_session_id"] == "general" && r["reserved_session_id"].is_null())
    );
    assert_eq!(rows[0]["status"], "blocked");
    assert_eq!(app_rows(&s).await?, Vec::<Value>::new());
    let attempts = super::work_model_live::database(&s, |db| {
        db.query_row(
            "SELECT count(*) FROM wm_attempts WHERE session_id='butler/app-general'",
            [],
            |r| r.get::<_, i64>(0),
        )
    })
    .await?;
    assert_eq!(attempts, 1);
    let task = rows[0]["id"].as_str().unwrap();
    *script.task.lock().unwrap() = task.to_owned();
    let target =
        s.gw.post("/sessions", json!({"kind":"chat","title":"Continue here"}))
            .await?;
    let target = target.data()["session"]["id"].as_str().unwrap().to_owned();
    let taken =
        s.gw.post(
            &format!("/sessions/{target}/task-ownership"),
            json!({"task_id":task,"decision":"take_here","expected_revision":rows[0]["revision"],"expected_owner_epoch":rows[0]["owner_epoch"]}),
        )
        .await?;
    assert_eq!(taken.status, 200, "{taken:?}");
    let opened =
        s.gw.post(&format!("/tasks/{task}/session"), json!({}))
            .await?;
    assert_eq!(opened.status, 200, "{opened:?}");
    assert_eq!(opened.data()["session_id"], target);
    assert!(
        app_rows(&s).await?.is_empty(),
        "An existing conversation remains a conversation after taking a Task"
    );
    s.finish().await?;
    server.abort();
    Ok(())
}
#[tokio::test]
async fn wmu_20_open_or_take_running_task_continues_checkpoint_without_holding_followers()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (s, script, server) = start("WMU-20").await?;
    let coordinator =
        s.gw.post("/sessions", json!({"kind":"chat","title":"Plan pieces"}))
            .await?;
    let coordinator = coordinator.data()["session"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    s.turn(&coordinator, PLAN).await?;
    tokio::time::timeout(Duration::from_secs(30), script.child_ready.acquire())
        .await
        .unwrap()
        .unwrap()
        .forget();
    let first = tasks_for(&s, &coordinator).await?[0].clone();
    let task = first["id"].as_str().unwrap().to_owned();
    *script.task.lock().unwrap() = task.clone();
    let created =
        s.gw.post("/sessions", json!({"kind":"chat","title":"Continue here"}))
            .await?;
    let chat = created.data()["session"]["id"].as_str().unwrap().to_owned();
    s.turn(&chat, TAKE).await?;
    let decision = ownership_result(&script);
    assert_eq!(decision["state"], "running", "{decision:?}");
    assert!(decision["message"].as_str().unwrap().contains("‘초안’"));
    let revision = decision["revision"].clone();
    let open =
        s.gw.post(
            &format!("/sessions/{chat}/task-ownership"),
            json!({"task_id":task,"decision":"open","expected_revision":revision,"expected_owner_epoch":decision["owner_epoch"]}),
        )
        .await?;
    assert_eq!(open.data()["session_id"], first["assignee_session_id"]);
    super::work_model_live::database(&s,|db| {
        db.execute("INSERT INTO wm_cross_db_intents(op_id,kind,payload_json,state,created_at) VALUES('task_continue:000-missing','task_continue','{\"task_id\":\"removed\",\"session_id\":\"unavailable\"}','pending',0)",[])
    }).await?;
    let moved =
        s.gw.post(
            &format!("/sessions/{chat}/task-ownership"),
            json!({"task_id":task,"decision":"take_here","expected_revision":revision,"expected_owner_epoch":decision["owner_epoch"]}),
        )
        .await?;
    assert_eq!(moved.status, 200, "{moved:?}");
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let now = tasks_for(&s, &coordinator).await?;
        if now[0]["assignee_session_id"] == chat && now[0]["status"] == "blocked" {
            assert_eq!(
                now[0]["owner_epoch"].as_i64(),
                first["owner_epoch"].as_i64().map(|n| n + 1)
            );
            assert!(now[1..].iter().all(|r| r["status"] != "held"));
            break;
        }
        assert!(Instant::now() < deadline, "{now:?}\n{}", s.agent.logs());
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let path = s.sandbox.data.join("app-server/butler-client.sqlite");
    let visible = tokio::task::spawn_blocking(move || {
        let db = rusqlite::Connection::open(path)?;
        db.query_row(
            "SELECT count(*) FROM messages WHERE role='user' AND (text LIKE 'Continue Task %' OR text='Continue.')",
            [],
            |r| r.get::<_, i64>(0),
        )
    })
    .await
    .unwrap()?;
    let messages = s.gw.messages(&chat).await?;
    assert!(
        !messages
            .iter()
            .any(|m| m["text"] == "Continue." || m["role"] == "system"),
        "{messages:?}"
    );
    let latest = tasks_for(&s, &coordinator).await?;
    let stale=s.gw.post(&format!("/sessions/{chat}/task-ownership"),json!({"task_id":task,"decision":"take_here","expected_revision":latest[0]["revision"],"expected_owner_epoch":first["owner_epoch"]})).await?;
    assert_eq!(stale.status, 409, "{stale:?}");
    assert_eq!(
        stale.body["error"]["message"],
        "이미 다른 대화로 옮겨졌습니다"
    );
    let navigation = s.gw.get("/navigation").await?;
    let old_session = &first["assignee_session_id"];
    let retained = navigation.data()["space"]["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|node| node["task_sessions"].as_array().into_iter().flatten())
        .any(|row| row["session_id"] == *old_session && row["task_id"] == task);
    assert!(
        visible == 0 && retained,
        "visible continuation rows={visible}, retained old conversation={retained}: {navigation:?}"
    );
    let evidence=super::work_model_live::database(&s,|db|db.query_row("SELECT a.status,a.checkpoint_ref,h.reason FROM wm_attempts a JOIN wm_holds h ON h.target=a.session_id WHERE a.task_id=?1 AND h.reason='handoff' ORDER BY a.started_at LIMIT 1",[task],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,String>(2)?)))).await?;
    assert_eq!(evidence.0, "interrupted");
    assert!(evidence.1.is_some());
    assert_eq!(evidence.2, "handoff");
    assert!(
        script
            .requests
            .lock()
            .unwrap()
            .iter()
            .flat_map(super::work_model_script::outputs)
            .any(|r| r["task_contexts"].as_object().is_some_and(|m| m
                .values()
                .any(|context| context["checkpoint_ref"].is_string()
                    && context["checkpoint"].is_string())))
    );
    let requester =
        s.gw.post(
            "/sessions",
            json!({"kind":"chat","title":"Another conversation"}),
        )
        .await?;
    let requester = requester.data()["session"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    s.turn(&requester, TAKE).await?;
    assert!(
        script
            .requests
            .lock()
            .unwrap()
            .iter()
            .flat_map(super::work_model_script::outputs)
            .any(|r| r["error"]["code"] == "owned_elsewhere"
                && r["error"]["message"]
                    .as_str()
                    .is_some_and(|m| m.contains("‘Continue here’")))
    );
    s.finish().await?;
    server.abort();
    Ok(())
}

async fn app_query_plans(s: &Scenario) -> Result<(), HarnessError> {
    let path = s.sandbox.data.join("app-server/butler-client.sqlite");
    tokio::task::spawn_blocking(move || -> Result<(), HarnessError> {
        let db = rusqlite::Connection::open(path)?;
        let mut plans = serde_json::Map::new();
        for (name, sql) in butler_gateway::gateway::storage_testing::task_session_query_statements()
            .into_iter()
            .chain(std::iter::once((
                "SESSION_TITLE",
                title_sql::SESSION_TITLE.to_owned(),
            )))
        {
            let mut stmt = db.prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?;
            let args = rusqlite::params_from_iter(std::iter::repeat_n(
                rusqlite::types::Value::Null,
                stmt.parameter_count(),
            ));
            let plan = stmt
                .query_map(args, |r| r.get::<_, String>(3))?
                .collect::<rusqlite::Result<Vec<_>>>()?
                .join("\n");
            plans.insert(name.into(), json!(plan));
        }
        let expected: Value = serde_json::from_str(include_str!(
            "../../fixtures/work-model-p14/task-session-app-plans.json"
        ))?;
        eprintln!("App session query plans: {}", json!(plans));
        assert_eq!(json!(plans), expected);
        Ok(())
    })
    .await
    .unwrap()
}

fn ownership_result(script: &stub::Script) -> Value {
    script
        .requests
        .lock()
        .unwrap()
        .iter()
        .rev()
        .flat_map(super::work_model_script::outputs)
        .find(|r| r["error"]["code"] == "owned_elsewhere")
        .unwrap()["error"]
        .clone()
}
