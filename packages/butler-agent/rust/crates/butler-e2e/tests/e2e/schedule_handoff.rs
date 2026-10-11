//! Missing child tools return to the parent, which finishes without a new owner message.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "test assertions"
)]
#[path = "support/schedule_handoff_stub.rs"]
mod stub;
use butler_e2e::e2e::{
    HarnessError,
    cassette::Cassette,
    scenario::{Setup, turn_timeout},
};
use serde_json::{Value, json};
use std::time::Duration;

#[tokio::test]
async fn missing_child_capability_returns_structurally_and_parent_completes()
-> Result<(), HarnessError> {
    butler_e2e::gate!();
    let (url, script, server) = stub::start().await?;
    let mut s = Setup::new("SCHEDULE-HANDOFF")?
        .stub_cassette(Cassette::load("TOOL-01")?)
        .env("BUTLER_CODEX_BASE_URL", &url)
        .start()
        .await?;
    assert_eq!(
        s.gw.patch(
            "/sessions/general/controls",
            json!({"access_mode":"ask_first"})
        )
        .await?
        .status,
        200
    );
    let (_, initial) = s.turn("general", stub::OWNER).await?;
    assert_eq!(initial["state"], "delivered", "{initial}");
    let (turn, reference) = wait_approval(&s).await?;
    assert_eq!(s.gw.get("/automations/handoff-briefing").await?.status, 404);
    let allowed =
        s.gw.post(
            &format!("/authority-requests/{reference}/allow?session_id=general"),
            json!({"scope":"once"}),
        )
        .await?;
    assert_eq!(allowed.status, 202, "{}", allowed.text);
    let done =
        s.gw.wait_terminal("general", &turn, Duration::from_secs(turn_timeout()))
            .await?;
    assert_eq!(done["state"], "delivered", "{done}");
    let schedule = s.gw.get("/automations/handoff-briefing").await?.data()["automation"].clone();
    assert_eq!(schedule["state"], "enabled");
    assert_eq!(schedule["prompt_body"], stub::arguments()["prompt"]);
    assert_eq!(schedule["next_run_at"], "2098-12-31T22:00:00.000Z");
    assert_eq!(schedule["access_mode"], "ask_first");
    assert_results(&s, &script, &turn).await?;
    migrate_legacy_results(&mut s).await?;
    s.finish().await?;
    server.abort();
    Ok(())
}
async fn wait_approval(
    s: &butler_e2e::e2e::scenario::Scenario,
) -> Result<(String, String), HarnessError> {
    let pending = tokio::time::timeout(Duration::from_secs(turn_timeout()), async {
        loop {
            let requests =
                s.gw.get("/authority-requests?session_id=general")
                    .await?
                    .data()
                    .clone();
            if let Some(request) = requests["requests"].as_array().unwrap().iter().next() {
                let reference = request["request_ref"]
                    .as_str()
                    .or_else(|| request["ref"].as_str())
                    .unwrap();
                return Ok::<_, HarnessError>((
                    request["source_turn_id"].as_str().unwrap().into(),
                    reference.into(),
                ));
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await;
    pending.unwrap_or_else(|_| panic!("approval never arrived: {}", s.agent.logs()))
}
async fn assert_results(
    s: &butler_e2e::e2e::scenario::Scenario,
    script: &stub::Script,
    turn: &str,
) -> Result<(), HarnessError> {
    let messages = s.gw.messages("general").await?;
    assert_eq!(messages.iter().filter(|m| m["role"] == "user").count(), 1);
    assert!(
        messages
            .iter()
            .any(|m| m["turn_id"] == turn && m["text"] == "예약 작업을 등록했습니다."),
        "{messages:?}"
    );
    assert!(
        !messages
            .iter()
            .any(|m| m["text"] == "예약을 등록하지 못했습니다.")
    );
    let db =
        butler_platform::sqlite::open(s.sandbox.data.join("agent-runtime/btcc.sqlite")).unwrap();
    let (code,input): (String,String)=db.query_row("SELECT r.code,o.input_json FROM btcc_steward_results r JOIN btcc_subsession_outbox o USING(result_id)",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
    assert_eq!(code, "capability_unavailable_in_child");
    assert!(input.contains("requested_action"));
    let count:i64=db.query_row("SELECT count(*) FROM btcc_guided_tool_calls WHERE turn_id=?1 AND tool_name='create_automation'",[turn],|r|r.get(0)).unwrap();
    assert_eq!(
        count, 1,
        "recovery must execute once in the same result Turn"
    );
    let requests = script.requests.lock().unwrap();
    let child: Vec<_> = requests
        .iter()
        .filter(|b| {
            b.to_string()
                .contains("Granted tools in this delegated session")
        })
        .collect();
    assert_ne!(child, [] as [&serde_json::Value; 0]);
    assert!(
        child
            .iter()
            .any(|b| b.to_string().contains("capability_unavailable_in_child"))
    );
    let mut statement = db.prepare("SELECT result_json FROM btcc_guided_tool_calls WHERE tool_name='tool_describe' ORDER BY started_at").unwrap();
    let outputs: Vec<Value> = statement
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .map(|encoded| serde_json::from_str(&encoded.unwrap()).unwrap())
        .collect();
    assert!(
        outputs
            .iter()
            .any(|o| o["descriptions"][0]["enabled"] == false)
    );
    assert!(
        outputs
            .iter()
            .any(|o| o["descriptions"][0]["enabled"] == true)
    );
    Ok(())
}

// Preview.6's result constraint predates the new code. Upgrade must retain known
// codes and direction revisions, and must not replay an already completed effect.
async fn migrate_legacy_results(
    s: &mut butler_e2e::e2e::scenario::Scenario,
) -> Result<(), HarnessError> {
    s.agent.terminate().await?;
    {
        let db = butler_platform::sqlite::open(s.sandbox.data.join("agent-runtime/btcc.sqlite"))
            .unwrap();
        let schema: String = db
            .query_row(
                "SELECT sql FROM sqlite_master WHERE name='btcc_steward_results'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let legacy = schema.replace("    'capability_unavailable_in_child',\n", "");
        assert_ne!(legacy, schema);
        db.execute(
            "UPDATE btcc_steward_results SET code='worker_no_progress',direction_revision=3",
            [],
        )
        .unwrap();
        db.execute_batch(
            "PRAGMA legacy_alter_table=ON; ALTER TABLE btcc_steward_results RENAME TO old_results",
        )
        .unwrap();
        db.execute_batch(&legacy).unwrap();
        db.execute_batch(
            "INSERT INTO btcc_steward_results SELECT * FROM old_results; DROP TABLE old_results; PRAGMA legacy_alter_table=OFF",
        )
        .unwrap();
    }
    s.gw = s.agent.start_again().await?;
    let db =
        butler_platform::sqlite::open(s.sandbox.data.join("agent-runtime/btcc.sqlite")).unwrap();
    let stored: (String, i64) = db
        .query_row(
            "SELECT code,direction_revision FROM btcc_steward_results",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(stored, ("worker_no_progress".into(), 3));
    let count: i64 = db
        .query_row(
            "SELECT count(*) FROM btcc_guided_tool_calls WHERE tool_name='create_automation'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
    assert_eq!(
        s.gw.get("/automations/handoff-briefing").await?.data()["automation"]["state"],
        "enabled"
    );
    Ok(())
}
