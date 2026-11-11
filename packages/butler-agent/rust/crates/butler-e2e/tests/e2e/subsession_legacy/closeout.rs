//! Cards older builds left open after their child saved its result close on start.
use super::{legacy_packet, seed_child_turn};
use butler_e2e::e2e::HarnessError;
use butler_e2e::e2e::scenario::{Scenario, Setup};
use butler_platform::sqlite;
use serde_json::json;

/// SUB-LEGACY-02 — a Steward that older builds left as below: its result saved on
/// its last Turn, its first Turn still waiting on Workers, and the English
/// placeholder title. After a restart it leaves 하위 작업, and the activity list
/// shows it complete under its task's own title.
#[tokio::test]
async fn sub_legacy_02_saved_results_close_their_cards() -> Result<(), HarnessError> {
    butler_e2e::gate!();
    let mut s = Setup::new("SUB-LEGACY-02")?.start().await?;
    let created = s.gw.post("/sessions", json!({"kind": "chat"})).await?;
    assert_eq!(created.status, 201, "{}", created.text);
    let session = &created.data()["session"];
    let chat = session["id"].as_str().unwrap().to_owned();
    let hint = session["session_hint"].as_str().unwrap().to_owned();
    s.agent.terminate().await?;
    seed(&s, &hint);
    s.gw = s.agent.start_again().await?;

    let view =
        s.gw.get(&format!("/session-view?session_id={chat}"))
            .await?;
    assert_eq!(view.status, 200, "{}", view.text);
    assert_eq!(view.data()["subtasks"], json!([]), "{}", view.text);
    let activity = s.gw.get("/worker-activity?include_history=true").await?;
    assert_eq!(activity.status, 200, "{}", activity.text);
    let steward = activity.data()["workers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["worker_id"] == "steward-relation-g")
        .unwrap_or_else(|| panic!("steward-relation-g missing: {}", activity.text));
    assert_eq!(
        steward["objective"], "Made-up legacy objective",
        "{steward}"
    );
    assert_eq!(steward["phase"], "complete", "{steward}");
    s.finish().await
}

/// Steward `g` as older builds left it.
fn seed(s: &Scenario, hint: &str) {
    let db = sqlite::open(s.sandbox.data.join("agent-runtime/btcc.sqlite")).unwrap();
    db.execute(
        "INSERT INTO btcc_session_relations (relation_id,parent_session_id,parent_turn_id,child_session_id,anchor_message_id,ordinal,safe_title,created_at) VALUES ('relation-g',?1,'turn-legacy','steward-legacy-g','message-legacy',1,'Delegated task','2026-01-01T00:00:00.000Z')",
        [hint],
    )
    .unwrap();
    db.execute(
        "INSERT INTO btcc_subsession_delegations (delegation_id,relation_id,task_id,child_turn_id,root_work_id,packet_json,created_at) VALUES ('delegation-g','relation-g','task-g','child-turn-g','work-g',?1,'2026-01-01T00:00:00.000Z')",
        [legacy_packet("g", hint, false).to_string()],
    )
    .unwrap();
    seed_child_turn(&db, "g", "steward-legacy-g", "admitted");
    db.execute(
        "UPDATE btcc_turns SET suspension_reason='waiting_for_worker' WHERE turn_id='child-turn-g'",
        [],
    )
    .unwrap();
    seed_child_turn(&db, "g2", "steward-legacy-g", "delivered");
    db.execute(
        "INSERT INTO btcc_steward_results (result_id,relation_id,task_id,child_session_id,child_turn_id,status,summary,acceptance_evidence_json,changed_artifacts_json,created_at) VALUES ('result-g','relation-g','task-g','steward-legacy-g','child-turn-g2','success','Made-up summary','[]','[]','2026-01-01T00:00:03.000Z')",
        [],
    )
    .unwrap();
}
