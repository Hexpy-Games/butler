//! Existing plan/delegation records, without a future Task-model store.
use butler_e2e::e2e::HarnessError;
use rusqlite::{Connection, params};
use serde_json::json;
use std::path::Path;

pub(super) const START: &str = "2026-10-01T01:00:00Z";
pub(super) const FINISH: &str = "2026-10-01T01:00:07Z";

pub(super) fn seed(data: &Path, parent: &str, graphs: usize) -> Result<(), HarnessError> {
    let mut db = Connection::open(data.join("agent-runtime/btcc.sqlite"))?;
    let tx = db.transaction()?;
    let parent_turn = format!("parent-turn-{graphs}");
    tx.execute("INSERT INTO btcc_inbound_inbox(inbox_id,session_id,trigger_key,turn_id,admission_input_hash,command_json,status) VALUES(?1,?2,?1,?1,'fixture','{}','constructed')",params![parent_turn,parent])?;
    tx.execute("INSERT INTO btcc_turns(turn_id,session_id,inbox_id,trigger_key,original_message_id,original_message,admission_snapshot_ref,model_selection_json,context_json,semantic_state,revision,execution_fence) VALUES(?1,?2,?1,?1,'message','Fixture','fixture','{}','{}','delivered',1,1)",params![parent_turn,parent])?;
    for g in 0..graphs {
        let plan = format!("graph-{graphs}-{g}");
        let work = format!("source-{graphs}-{g}");
        let actions = json!([
            {"actionKey":"a","description":"Prepare","dependencyKeys":[]},
            {"actionKey":"b","description":"Build","dependencyKeys":["a"]},
            {"actionKey":"c","description":"Check","dependencyKeys":["a"]},
            {"actionKey":"d","description":"Combine","dependencyKeys":["b","c"]},
            {"actionKey":"e","description":"Publish","dependencyKeys":["d"]}
        ]);
        tx.execute("INSERT INTO btcc_guided_works(work_id,session_id,scope_kind,scope_ref,origin_turn_id,origin_message_id,objective,status,current_plan_revision_id,created_at,updated_at) VALUES(?1,?2,'session',?2,?5,'message','Work Steward WorkModel delegate_to_worker network api_client.rs release','open',?3,?4,?4)",params![work,parent,plan,START,parent_turn])?;
        tx.execute(r#"INSERT INTO btcc_guided_work_plan_revisions(plan_revision_id,work_id,revision,objective,governing_refs_json,execution_mode,actions_json,checks_json,origin_turn_id,created_at) VALUES(?1,?2,1,'Work Steward WorkModel delegate_to_worker network api_client.rs release','["SPEC-1@rev-1"]','workers',?3,'["All checks pass","api_client.rs is complete"]',?5,?4)"#,params![plan,work,actions.to_string(),START,parent_turn])?;
        for (i, (key, status)) in [("a", "success"), ("b", "failed"), ("c", "cancelled")]
            .iter()
            .enumerate()
        {
            let task = format!("task-{graphs}-{g}-{key}");
            let child = format!("worker-graph-{graphs}-{g}-{key}");
            let relation = format!("relation-{graphs}-{g}-{key}");
            let turn = format!("turn-{graphs}-{g}-{key}");
            let packet = json!({"child_role":"worker","delegation_id":relation,"task_id":task,"parent_session_id":parent,"parent_turn_id":parent_turn,"relation_id":relation,"access_mode":"read_only","execution_mode":"read_only","objective":actions[i]["description"],"acceptance_criteria":if *key=="a" {json!([])}else{json!(["All checks pass"])},"task_or_plan_refs":[],"constraints_and_non_goals":[],"allowed_tools_and_effects":[],"mutation_scope":[],"plan_action":{"action_key":key,"description":actions[i]["description"],"dependency_keys":actions[i]["dependencyKeys"]},"parent_work_ref":{"work_id":work,"session_id":parent,"turn_id":parent_turn,"plan_revision_id":plan,"review_revision_id":"review"},"model_ref":"openai/gpt-6-luna","reasoning_effort":"max"});
            tx.execute("INSERT INTO btcc_session_relations(relation_id,parent_session_id,parent_turn_id,child_session_id,anchor_message_id,ordinal,safe_title,created_at) VALUES(?1,?2,?7,?3,'anchor',?4,?5,?6)",params![relation,parent,child,i64::try_from(g*3+i+1).unwrap(),actions[i]["description"].as_str().unwrap(),"2026-10-01T00:59:50Z",parent_turn])?;
            tx.execute("INSERT INTO btcc_subsession_delegations(delegation_id,relation_id,task_id,child_turn_id,root_work_id,packet_json,created_at) VALUES(?1,?1,?2,?3,?4,?5,?6)",params![relation,task,turn,format!("root-{task}"),packet.to_string(),START])?;
            tx.execute("INSERT INTO btcc_inbound_inbox(inbox_id,session_id,trigger_key,turn_id,admission_input_hash,command_json,status) VALUES(?1,?2,?1,?1,'fixture','{}','constructed')",params![turn,child])?;
            tx.execute("INSERT INTO btcc_turns(turn_id,session_id,inbox_id,trigger_key,original_message_id,original_message,admission_snapshot_ref,model_selection_json,context_json,semantic_state,revision,execution_fence) VALUES(?1,?2,?1,?1,?1,'Fixture','fixture','{}','{}',?3,1,1)",params![turn,child,if *status=="cancelled" {"cancelled"}else{"delivered"}])?;
            tx.execute("INSERT INTO btcc_steward_results(result_id,relation_id,task_id,child_session_id,child_turn_id,status,summary,acceptance_evidence_json,changed_artifacts_json,created_at) VALUES(?1,?1,?2,?3,?4,?5,'Result','[]','[]',?6)",params![relation,task,child,turn,status,FINISH])?;
        }
    }
    tx.commit()?;
    let db = Connection::open(data.join("runtime/conversation-store.sqlite"))?;
    for g in 0..graphs {
        for key in ["a", "b", "c"] {
            let child = format!("worker-graph-{graphs}-{g}-{key}");
            db.execute(
                "INSERT INTO conversation_sessions(id,gateway_origin,created_at,updated_at,status,schema_version) VALUES(?1,'app',?2,?3,'active',5)",
                params![child, START, FINISH],
            )?;
            db.execute("INSERT INTO conversation_turns(id,session_id,seq,actor,status,started_at,completed_at) VALUES(?1,?2,1,'assistant','complete',?3,?4)",params![format!("turn-{graphs}-{g}-{key}"),child,START,FINISH])?;
        }
    }
    Ok(())
}
