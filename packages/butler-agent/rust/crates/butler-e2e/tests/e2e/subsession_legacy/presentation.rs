//! Public child progress survives restart without an App turn row.
use butler_e2e::e2e::scenario::Scenario;
use serde_json::{Value, json};

pub(super) fn seed(s: &Scenario) {
    let db = rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite")).unwrap();
    let events = [
        json!({"kind":"tool.started","visibility":"public","payload":{"toolName":"read_file","toolCallId":"read-one","safeLabel":"Read source"}}),
        json!({"kind":"tool.completed","visibility":"public","payload":{"toolName":"read_file","toolCallId":"read-one","safeLabel":"Source read"}}),
        json!({"kind":"assistant.public_note","visibility":"public","payload":{"note":"Checking the result"}}),
        json!({"kind":"assistant.public_note","visibility":"internal","payload":{"note":"PRIVATE-DIRECTION"}}),
    ];
    for (sequence, event) in (1..).zip(events) {
        let id = format!("progress-b-{sequence}");
        db.execute("INSERT INTO btcc_progress_events(event_id,action_id,session_id,turn_id,session_sequence,turn_sequence,event_fingerprint,event_json,destination_json,status,created_at) VALUES (?1,?1,'steward-legacy-b','child-turn-b',?2,?2,?1,?3,'{}','published','2026-01-01T00:00:01.000Z')", rusqlite::params![id, sequence, event.to_string()]).unwrap();
    }
    db.execute_batch("INSERT INTO btcc_guided_works(work_id,session_id,scope_kind,scope_ref,origin_turn_id,origin_message_id,objective,status,current_plan_revision_id,created_at,updated_at) VALUES ('work-b','steward-legacy-b','session','steward-legacy-b','child-turn-b','message-legacy','Read and verify','open','plan-b','2026-01-01T00:00:00Z','2026-01-01T00:00:01Z');
        INSERT INTO btcc_guided_turn_work_bindings VALUES ('binding-b','child-turn-b','steward-legacy-b','work-b',1,1,'2026-01-01T00:00:00Z');").unwrap();
    let actions = json!([{"actionKey":"read","description":"Read","dependencyKeys":[]},{"actionKey":"verify","description":"Verify","dependencyKeys":["read"]}]);
    db.execute("INSERT INTO btcc_guided_work_plan_revisions VALUES ('plan-b','work-b',1,'Read and verify','[]','direct',?1,'[\"Complete\"]','child-turn-b','2026-01-01T00:00:00Z')", [actions.to_string()]).unwrap();
    db.execute_batch("INSERT INTO btcc_guided_work_review_revisions(review_revision_id,work_id,revision,subject,verdict,summary,corrections_json,bound_plan_revision_id,origin_turn_id,created_at) VALUES ('review-b','work-b',1,'plan','accept','Approved','[]','plan-b','child-turn-b','2026-01-01T00:00:00Z');").unwrap();
    let progress =
        json!([{"actionKey":"read","status":"done"},{"actionKey":"verify","status":"active"}]);
    db.execute("INSERT INTO btcc_guided_work_checkpoint_revisions VALUES ('checkpoint-b','work-b',1,'plan-b','execution','Checking the result','Verify',?1,0,'child-turn-b','2026-01-01T00:00:01Z')", [progress.to_string()]).unwrap();
}

pub(super) fn assert_child(child: &Value) {
    assert_eq!(child["approved_plan_revision"], 1, "{child}");
    assert_eq!(child["approved_plan_total"], 2);
    assert_eq!(child["approved_plan_completed"], 1);
    let progress = &child["latest_turn"]["progress"];
    assert_eq!(progress["safe_progress_rows"].as_array().unwrap().len(), 3);
    assert_eq!(progress["summary"], "Checking the result");
    assert_eq!(progress["safe_status_label"], progress["summary"]);
    assert_eq!(child["activity_rows"], progress["safe_progress_rows"]);
    assert!(!child.to_string().contains("PRIVATE-DIRECTION"));
    assert!(child.get("public_progress_events").is_none());
}

pub(super) async fn assert_waiting_children(
    s: &mut Scenario,
    chat: &str,
) -> Result<(), butler_e2e::e2e::HarnessError> {
    s.agent.terminate().await?;
    {
        let db =
            rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite")).unwrap();
        let packet = super::legacy_packet("waiting", "steward-legacy-b", true);
        db.execute_batch("INSERT INTO btcc_session_relations (relation_id,parent_session_id,parent_turn_id,child_session_id,anchor_message_id,ordinal,safe_title,created_at) VALUES ('relation-waiting','steward-legacy-b','child-turn-b','worker-waiting','waiting-anchor',1,'Waiting worker','2026-01-01T00:00:00Z');").unwrap();
        db.execute("INSERT INTO btcc_subsession_delegations (delegation_id,relation_id,task_id,child_turn_id,root_work_id,packet_json,created_at) VALUES ('delegation-waiting','relation-waiting','task-waiting','turn-waiting','work-waiting',?1,'2026-01-01T00:00:00Z')", [packet.to_string()]).unwrap();
    }
    s.gw = s.agent.start_again().await?;
    let view =
        s.gw.get(&format!("/session-view?session_id={chat}"))
            .await?;
    assert_eq!(
        view.data()["steward_children"][1]["waiting_for_children"],
        true,
        "{view:?}"
    );
    let own =
        s.gw.get("/session-view?session_id=steward-legacy-b")
            .await?;
    assert_eq!(own.data()["waiting_for_children"], true);
    s.agent.terminate().await?;
    {
        let db =
            rusqlite::Connection::open(s.sandbox.data.join("agent-runtime/btcc.sqlite")).unwrap();
        db.execute_batch("INSERT INTO btcc_steward_results (result_id,relation_id,task_id,child_session_id,child_turn_id,status,summary,acceptance_evidence_json,changed_artifacts_json,created_at) VALUES ('result-waiting','relation-waiting','task-waiting','worker-waiting','turn-waiting','success','Done','[]','[]','2026-01-01T00:00:01Z');").unwrap();
    }
    s.gw = s.agent.start_again().await?;
    let own =
        s.gw.get("/session-view?session_id=steward-legacy-b")
            .await?;
    assert_eq!(own.data()["waiting_for_children"], false);
    Ok(())
}
