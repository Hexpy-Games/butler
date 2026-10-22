//! Every operational statement is declared here so query-plan coverage is total.
macro_rules! statements {
    ($($name:ident = $sql:literal;)+) => {
        $(pub const $name: &str = $sql;)+
        pub const ALL: &[(&str,&str)] = &[$((stringify!($name),$name)),+];
    }
}
statements! {
WORK_STATE = "UPDATE wm_works SET run_state=?2,canon_status=?3,canon_status_source=?4,failure_reason=?5,run_generation=run_generation+(run_state<>?2),revision=revision+1,updated_at=?6 WHERE id=?1";
RECOVER_PART = "UPDATE wm_task_parts SET status=?2,revision=revision+1 WHERE id=?1 AND status IN ('running','awaiting_review')";
RECOVERY_SESSION = "SELECT session_id FROM wm_attempts WHERE status='running' AND session_id>?1 AND recovered_at IS NULL UNION SELECT session_id FROM wm_attempts WHERE status='interrupted' AND session_id>?1 AND recovered_at IS NULL ORDER BY session_id LIMIT 1";
CHECKPOINT_SESSION = "UPDATE wm_attempts SET status='interrupted',finished_at=?2,revision=revision+1 WHERE session_id=?1 AND status='running'";
CANCEL_PARTS = "UPDATE wm_task_parts SET status='cancelled',revision=revision+1 WHERE task_id=?1 AND status IN ('pending','running','awaiting_review','failed')";
WORK = "SELECT * FROM wm_works WHERE id=?1";
PLAN = "SELECT * FROM wm_plans WHERE id=?1";
INSERT_PLAN = "INSERT INTO wm_plans(id,project_id,title,description,due_on,status,visibility,created_at,updated_at,created_by) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?8,?9)";
EDIT_PLAN = "UPDATE wm_plans SET title=?2,description=?3,due_on=?4,status=?5,revision=revision+1,updated_at=?6 WHERE id=?1 AND revision=?7";
INSERT_WORK = "INSERT INTO wm_works(id,scope_kind,scope_ref,title,description,origin,draft,visibility,canon_status,created_at,updated_at,created_by,assignee) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10,?11,?12)";
EDIT_WORK = "UPDATE wm_works SET title=?2,description=?3,kind=?4,assignee=?5,draft=?6,tier=?7,revision=revision+1,updated_at=?8 WHERE id=?1 AND revision=?9";
HOME = "UPDATE wm_works SET home_session_id=?2,revision=revision+1,updated_at=?3 WHERE id=?1 AND revision=?4";
RANK = "UPDATE wm_works SET plan_id=?2,plan_rank=?3,revision=revision+1,updated_at=?4 WHERE id=?1 AND revision=?5";
AUDIT = "INSERT INTO wm_audit(entity_kind,entity_id,revision,actor_json,op,at,payload_json) VALUES(?1,?2,?3,?4,?5,?6,?7)";
OUTBOX_START = "SELECT coalesce(max(seq),0) FROM wm_outbox";
OUTBOX = "INSERT INTO wm_outbox(topic,payload_json,created_at) VALUES(?1,?2,?3)";
COUNT_ROW = "SELECT count FROM wm_counts WHERE scope_kind=?1 AND scope_ref=?2 AND key=?3";
SCOPE_COUNTS = "SELECT run_state,count(*) AS count FROM wm_works WHERE scope_kind=?1 AND scope_ref=?2 GROUP BY run_state";
COUNT = "INSERT INTO wm_counts(scope_kind,scope_ref,key,count) VALUES(?1,?2,?3,MAX(?4,0)) ON CONFLICT(scope_kind,scope_ref,key) DO UPDATE SET count=count+?4";
CHAIN = "SELECT * FROM wm_task_chains WHERE id=?1";
MEMBERS = "SELECT * FROM wm_tasks WHERE chain_id=?1 ORDER BY step_index,stack_position";
INSERT_CHAIN = "INSERT INTO wm_task_chains(id,work_id,created_at) VALUES(?1,?2,?3)";
BUMP_CHAIN = "UPDATE wm_works SET task_graph_revision=task_graph_revision+1 WHERE id=?1 AND task_graph_revision=?2";
CHAIN_STATE = "UPDATE wm_task_chains SET state=?2 WHERE id=?1";
DELETE_EDGES = "DELETE FROM wm_task_edges WHERE chain_id=?1";
INSERT_EDGE = "INSERT INTO wm_task_edges(pred,succ,chain_id,work_id) SELECT ?1,?2,?3,work_id FROM wm_task_chains WHERE id=?3";
MEMBERSHIP = "UPDATE wm_tasks SET chain_id=?2,step_index=?3,stack_position=?4,revision=revision+1,updated_at=?5 WHERE id=?1 AND revision=?6";
PROVENANCE = "UPDATE wm_tasks SET origin=?2,origin_message_id=?3 WHERE id=?1";
STATE = "UPDATE wm_tasks SET status=?2,hold_reason=?3,held_by_task_id=?4,failure_reason=?5,result_reported_at=?6,revision=revision+1,updated_at=?7 WHERE id=?1 AND revision=?8";
CANCEL_TASK = "UPDATE wm_tasks SET status='cancelled',hold_reason=NULL,held_by_task_id=NULL,failure_reason=NULL,blocked_reason=?2,revision=revision+1,updated_at=?3 WHERE id=?1 AND revision=?4";
INSERT_TASK = "INSERT INTO wm_tasks(id,work_id,spec_ref,title,status,chain_id,step_index,stack_position,origin,origin_message_id,created_at,updated_at,created_by) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?11,?12)";
TASK = "SELECT * FROM wm_tasks WHERE id=?1";
TASKS = "SELECT * FROM wm_tasks WHERE work_id=?1 AND status IN ('draft','waiting','pending','running','in_review','held','failed','blocked','paused','stopped')";
INSERT_HOLD = "INSERT INTO wm_task_hold_decisions(id,chain_id,failed_task_id,held_step_index,question_message_id,coverage_json) VALUES(?1,?2,?3,?4,?5,?6)";
RESOLVE_HOLD = "UPDATE wm_task_hold_decisions SET resolved_at=?2,revision=revision+1 WHERE id=?1 AND revision=?3 AND resolved_at IS NULL";
HOLD = "SELECT * FROM wm_task_hold_decisions WHERE id=?1";
PENDING_HOLDS = "SELECT * FROM wm_task_hold_decisions WHERE chain_id=?1 AND decision IS NULL AND resolved_at IS NULL ORDER BY held_step_index";
MOVE_SCOPE = "UPDATE wm_works SET scope_ref=?2,revision=revision+1,updated_at=?3 WHERE id=?1 AND revision=?4";
DECIDED_HOLDS = "SELECT * FROM wm_task_hold_decisions WHERE chain_id=?1 AND decision='run_anyway' AND resolved_at IS NULL";
REPOINT_HOLD = "UPDATE wm_task_hold_decisions SET failed_task_id=?2,coverage_json=?4,revision=revision+1 WHERE id=?1 AND revision=?3";
DECIDE = "UPDATE wm_task_hold_decisions SET decision=?2,decided_at=?3,revision=revision+1 WHERE id=?1 AND revision=?4 AND decision IS NULL";
INTENT = "SELECT * FROM wm_cross_db_intents WHERE op_id=?1";
INSERT_INTENT = "INSERT INTO wm_cross_db_intents(op_id,kind,payload_json,state,created_at) VALUES(?1,?2,?3,'pending',?4) ON CONFLICT(op_id) DO NOTHING";
PENDING_INTENTS = "SELECT * FROM wm_cross_db_intents WHERE state='pending' AND op_id>?1 ORDER BY op_id LIMIT ?2";
APPLY_INTENT = "UPDATE wm_cross_db_intents SET state='applied',revision=revision+1 WHERE op_id=?1 AND revision=?2";
MARKER = "SELECT * FROM wm_runtime_marker WHERE singleton=1";
BOOT = "INSERT INTO wm_runtime_marker(singleton,boot_id,started_at) VALUES(1,?1,?2) ON CONFLICT(singleton) DO UPDATE SET boot_id=?1,started_at=?2,clean_shutdown_at=NULL";
CLEAN = "UPDATE wm_runtime_marker SET clean_shutdown_at=?1 WHERE singleton=1 AND boot_id=?2";
RECOVER_ATTEMPTS = "SELECT a.*,t.work_id FROM wm_attempts a JOIN wm_tasks t ON t.id=a.task_id WHERE a.session_id=?1 AND a.status='running' AND a.recovered_at IS NULL AND NOT EXISTS(SELECT 1 FROM wm_cross_db_intents i WHERE i.op_id='child_dispatch:'||a.id AND i.state='pending') UNION ALL SELECT a.*,t.work_id FROM wm_attempts a JOIN wm_tasks t ON t.id=a.task_id WHERE a.session_id=?1 AND a.status='interrupted' AND a.recovered_at IS NULL AND NOT EXISTS(SELECT 1 FROM wm_cross_db_intents i WHERE i.op_id='child_dispatch:'||a.id AND i.state='pending') ORDER BY started_at,id";
INTERRUPT = "UPDATE wm_attempts SET status='interrupted',finished_at=?2,recovered_at=?2,revision=revision+1 WHERE id=?1 AND revision=?3 AND recovered_at IS NULL";
NODE = "SELECT * FROM wm_spec_nodes WHERE node_id=?1";
INSERT_NODE = "INSERT INTO wm_spec_nodes(node_id,scope_kind,scope_ref,work_id,parent_node_id,concern_id,visibility,lifecycle,source,created_at,updated_at,created_by) VALUES(?1,?2,?3,?4,?5,?6,?7,'draft','local',?8,?8,?9)";
BODY = "SELECT hash,bytes FROM wm_spec_bodies WHERE hash=?1";
PUT_BODY = "INSERT INTO wm_spec_bodies(hash,body,bytes) VALUES(?1,?2,?3) ON CONFLICT(hash) DO NOTHING";
SPEC_REVISION = "SELECT * FROM wm_spec_revisions WHERE node_id=?1 AND revision=?2";
PUBLISH = "INSERT INTO wm_spec_revisions(node_id,revision,body_hash,parser_version,state,authoring_instruction_id) VALUES(?1,?2,?3,?4,'published',?5)";
CRITERION = "INSERT INTO wm_spec_criteria(node_id,revision,criterion_id,part_id,text) VALUES(?1,?2,?3,?4,?5)";
NODE_BUMP = "UPDATE wm_spec_nodes SET revision=revision+1,updated_at=?2 WHERE node_id=?1 AND revision=?3";
ACTIVATE = "UPDATE wm_spec_nodes SET active_revision=?2,lifecycle='active',revision=revision+1,updated_at=?3 WHERE node_id=?1 AND revision=?4 AND active_revision IS ?5";
SPEC_STATE = "UPDATE wm_spec_revisions SET state=?3 WHERE node_id=?1 AND revision=?2";
CONTROL_KEY = "SELECT * FROM wm_instructions WHERE idempotency_key=?1";
CONTROL_NEXT = "SELECT * FROM wm_instructions WHERE target_session_id=?1 AND status IN ('accepted','waiting_for_turn','waiting_for_task','pending_safe_point') AND (anchor_kind='task' OR json_extract(sender,'$.origin')='migration') AND (?2=0 OR mode='steer') ORDER BY received_seq,id";
CONTROL_SEQUENCE = "SELECT coalesce(max(seq),0)+1 AS seq FROM wm_audit";
CONTROL_INSERT = "INSERT INTO wm_instructions(id,idempotency_key,target_session_id,sender,mode,body_ref,anchor_kind,anchor_id,boundary_seq,status,received_seq) VALUES(?1,?2,?3,?4,?5,?6,'task',?7,?8,?9,?8)";
CONTROL_EPOCH = "UPDATE wm_session_exec SET control_epoch=control_epoch+1 WHERE session_id=?1 AND control_epoch=?2";
CONTROL_STATUS = "UPDATE wm_instructions SET status=?2 WHERE id=?1 AND status=?3";
CONTROL_STATE = "UPDATE wm_session_exec SET control_state=?2 WHERE session_id=?1";
HOLD_INSERT = "INSERT INTO wm_holds(id,target,owner,kind) VALUES(?1,?2,?3,?4)";
CONTROL_HOLD = "SELECT * FROM wm_holds WHERE id=?1";
HOLDS = "SELECT * FROM wm_holds WHERE target=?1 AND released_at IS NULL ORDER BY id";
HOLD_RELEASE = "UPDATE wm_holds SET released_at=?2 WHERE id=?1 AND released_at IS NULL";

}
