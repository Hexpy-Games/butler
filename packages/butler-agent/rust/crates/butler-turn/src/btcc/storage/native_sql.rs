//! Native runtime statements, shared with indexed query-plan pins.
pub(crate) const SUBSESSIONS_SERVICE_TASK_PART_COUNTS: &str = "SELECT count(*),coalesce(sum(status='completed'),0) FROM wm_task_parts WHERE assignee_session_id=?1 AND status<>'cancelled'";
pub(crate) const WORKER_RUNNING_COUNT: &str = "SELECT count(*) FROM btcc_session_relations r WHERE r.parent_session_id=?1 AND r.activity_role='worker' AND EXISTS(SELECT 1 FROM wm_attempts a WHERE a.session_id=r.child_session_id AND a.status='running' AND NOT EXISTS(SELECT 1 FROM wm_cross_db_intents i WHERE i.op_id='child_dispatch:'||a.id AND i.state='pending'))";
pub(crate) const WORKER_NEXT_WAITING: &str = "SELECT json_extract(i.payload_json,'$.delegation.child_session_id') FROM wm_cross_db_intents i WHERE i.kind='child_dispatch' AND json_extract(i.payload_json,'$.delegation.parent_session_id')=?1 AND i.state='pending' AND json_extract(i.payload_json,'$.delegation.packet.child_role')='worker' ORDER BY i.created_at,i.rowid LIMIT 1";
pub(crate) const WORKER_DISPATCH_PENDING: &str =
    "SELECT state='pending' FROM wm_cross_db_intents WHERE op_id=?1";
pub(crate) const STORAGE_SUBSESSIONS_COMPLETION_1: &str = "SELECT a.id FROM wm_session_exec s JOIN wm_attempts a ON a.task_id=s.current_task_id WHERE s.session_id=?1 AND a.session_id=?1 AND a.turn_id=?2 ORDER BY a.started_at DESC LIMIT 1";
pub(crate) const STORAGE_SUBSESSIONS_COMPLETION_2: &str =
    "SELECT 1 FROM btcc_subsession_outbox WHERE result_id=?1";
pub(crate) const STORAGE_SUBSESSIONS_COMPLETION_3: &str =
    "SELECT 1 FROM btcc_subsession_outbox WHERE result_id=?1";
pub(crate) const STORAGE_SUBSESSIONS_COMPLETION_4: &str = "INSERT OR IGNORE INTO btcc_subsession_outbox(outbox_id,relation_id,result_id,parent_session_id,parent_turn_id,message_id,input_json,status,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,'pending',?8)";
pub(crate) const STORAGE_SUBSESSIONS_COMPLETION_5: &str =
    "UPDATE btcc_session_relations SET activity_terminal=1 WHERE relation_id=?1";
pub(crate) const STORAGE_SUBSESSIONS_COMPLETION_6: &str = "SELECT count(*) FROM btcc_session_relations r JOIN wm_session_exec s ON s.session_id=r.child_session_id JOIN wm_attempts origin ON origin.task_id=s.current_task_id AND origin.session_id=r.child_session_id JOIN wm_cross_db_intents i ON i.op_id='child_dispatch:'||origin.id JOIN wm_attempts a ON a.task_id=s.current_task_id AND a.session_id=r.child_session_id WHERE r.parent_session_id=?1 AND json_extract(i.payload_json,'$.delegation.packet.objective')=?2 AND a.status IN ('failed','interrupted') AND a.checkpoint_ref=?3";
pub(crate) const STORAGE_SUBSESSIONS_COMPLETION_7: &str =
    "SELECT final_payload_json FROM btcc_turns WHERE turn_id=?1";
pub(crate) const STORAGE_SUBSESSIONS_DIRECTIONS_1: &str = "SELECT DISTINCT r.relation_id,r.child_session_id FROM wm_instructions i INDEXED BY wm_instructions_pending CROSS JOIN btcc_session_relations r WHERE i.status IN ('accepted','waiting_for_turn','waiting_for_task','pending_safe_point') AND i.status IN ('waiting_for_task','pending_safe_point') AND r.child_session_id=i.target_session_id";
pub(crate) const STORAGE_SUBSESSIONS_DIRECTIONS_2: &str =
    "SELECT relation_id FROM btcc_session_relations WHERE child_session_id=?1";
pub(crate) const STORAGE_SUBSESSIONS_1: &str =
    "SELECT turn_id,semantic_state FROM btcc_turns WHERE session_id=?1 ORDER BY rowid DESC LIMIT 1";
pub(crate) const SUBSESSIONS_SERVICE_SESSION_CONTROL_1: &str =
    "SELECT tier FROM wm_session_exec WHERE session_id=?1";
pub(crate) const SUBSESSIONS_SERVICE_SESSION_CONTROL_2: &str =
    "SELECT payload_json FROM wm_cross_db_intents WHERE op_id=?1";
pub(crate) const SUBSESSIONS_SERVICE_SESSION_CONTROL_3: &str =
    "SELECT 1 FROM wm_holds WHERE id=?1 AND target=?2 AND owner=?3";
pub(crate) const SUBSESSIONS_SERVICE_LIFECYCLE_1: &str =
    "SELECT 1 FROM wm_attempts WHERE task_id=?1 AND session_id=?2 AND turn_id=?3";
pub(crate) const SUBSESSIONS_SERVICE_WAITING_TURN: &str = "SELECT 1 FROM btcc_turns WHERE turn_id=?1 AND suspension_reason='waiting_for_worker' AND active_checkpoint_id IS NULL";
pub(crate) const SUBSESSIONS_SERVICE_REPORT_CHILD: &str =
    "SELECT session_id FROM wm_attempts WHERE id=?1";
pub(crate) const SUBSESSIONS_SERVICE_LIFECYCLE_2: &str =
    "UPDATE btcc_session_relations SET activity_terminal=0 WHERE relation_id=?1";
pub(crate) const SUBSESSIONS_SERVICE_LATEST_PART: &str = "SELECT part_id FROM wm_attempts WHERE task_id=?1 AND session_id=?2 ORDER BY started_at DESC,id DESC LIMIT 1";
pub(crate) const SUBSESSIONS_SERVICE_CUTOVER_1: &str = "SELECT c.op_id,c.revision,i.id,t.trigger_key FROM wm_cross_db_intents c JOIN wm_instructions i ON i.id=json_extract(c.payload_json,'$.instruction_id') JOIN btcc_turns t ON t.turn_id=i.anchor_id WHERE c.kind='cutover_wait' AND c.state='pending' AND i.status IN ('waiting_for_turn','delivered')";

pub(crate) const STORAGE_SUBSESSIONS_NATIVE_INDEXED_1: &str = "SELECT a.id,a.turn_id,a.status,a.checkpoint_ref,a.finished_at,p.status \
        FROM wm_attempts a LEFT JOIN wm_task_parts p ON p.id=a.part_id WHERE a.task_id=?1 AND a.session_id=?2 ORDER BY a.started_at DESC,a.id DESC LIMIT 1";
pub(crate) const STORAGE_SUBSESSIONS_NATIVE_INDEXED_2: &str =
    "SELECT 1 FROM btcc_subsession_outbox WHERE result_id=?1";
pub(crate) const STORAGE_SUBSESSIONS_NATIVE_INDEXED_3: &str = "SELECT body_ref FROM wm_results WHERE task_id=?1 AND attempt_id=?2 ORDER BY revision DESC LIMIT 1";
pub(crate) const STORAGE_SUBSESSIONS_NATIVE_INDEXED_4: &str =
    "SELECT 1 FROM wm_spec_bodies WHERE hash=?1";
pub(crate) const STORAGE_SUBSESSIONS_NATIVE_INDEXED_5: &str =
    "SELECT final_payload_json FROM btcc_turns WHERE turn_id=?1";
pub(crate) const STORAGE_SUBSESSIONS_INDEXED_1: &str = "SELECT turn_id,semantic_state,trigger_key,original_message_id,original_message \
             FROM btcc_turns WHERE session_id=?1 ORDER BY rowid DESC LIMIT 1";
pub(crate) const STORAGE_SUBSESSIONS_INDEXED_2: &str =
    "SELECT 1 FROM btcc_turns WHERE turn_id=?1 AND session_id=?2 AND original_message_id=?3";
pub(crate) const STORAGE_SUBSESSIONS_INDEXED_3: &str =
    "SELECT status FROM btcc_guided_works WHERE work_id=?1";
pub(crate) const STORAGE_SUBSESSIONS_INDEXED_4: &str = "SELECT EXISTS(SELECT 1 FROM btcc_session_relations r JOIN wm_attempts a ON a.session_id=r.child_session_id AND a.status='running' WHERE r.parent_session_id=?1 AND NOT EXISTS(SELECT 1 FROM wm_holds h WHERE h.target=r.child_session_id AND h.released_at IS NULL)) OR EXISTS(SELECT 1 FROM wm_delegation_reports d JOIN wm_attempts a ON a.id=d.attempt_id WHERE d.parent_session_id=?1 AND (d.delivered_at IS NULL OR d.delivery_ended_at IS NULL) AND NOT EXISTS(SELECT 1 FROM wm_holds h WHERE h.target=a.session_id AND h.released_at IS NULL))";
pub(crate) const STORAGE_SUBSESSIONS_INDEXED_5: &str = "SELECT result_id,parent_session_id,input_json FROM btcc_subsession_outbox WHERE status='pending' ORDER BY created_at";
pub(crate) const STORAGE_SUBSESSIONS_INDEXED_6: &str = "UPDATE btcc_subsession_outbox SET status='delivered',delivered_at=?2 WHERE result_id=?1 AND status='pending'";
pub(crate) const SUBSESSIONS_SERVICE_ADMISSION_INDEXED_1: &str =
    "SELECT current_task_id FROM wm_session_exec WHERE session_id=?1";
pub(crate) const SUBSESSIONS_SERVICE_ADMISSION_INDEXED_2: &str =
    "SELECT payload_json FROM wm_cross_db_intents WHERE op_id=?1";
pub(crate) const SUBSESSIONS_SERVICE_ADMISSION_INDEXED_3: &str =
    "SELECT task_id,part_id FROM wm_attempts WHERE id=?1";
pub(crate) const SUBSESSIONS_SERVICE_ADMISSION_INDEXED_4: &str =
    "SELECT coalesce(max(ordinal),0)+1 FROM btcc_session_relations WHERE parent_session_id=?1";
pub(crate) const SUBSESSIONS_SERVICE_ADMISSION_INDEXED_5: &str = "INSERT OR IGNORE INTO btcc_session_relations(relation_id,parent_session_id,parent_turn_id,child_session_id,anchor_message_id,ordinal,safe_title,created_at,activity_role,activity_worker_id) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?4)";
pub(crate) const SUBSESSIONS_SERVICE_ADMISSION_INDEXED_6: &str =
    "SELECT text FROM wm_spec_criteria WHERE node_id=?1 AND revision=?2 AND criterion_id=?3";
pub(crate) const STORAGE_SUBSESSIONS_NATIVE_COMPLETION_INDEXED_1: &str = "SELECT id,status,part_id FROM wm_attempts WHERE task_id=?1 AND session_id=?2 AND turn_id=?3 ORDER BY started_at DESC,id DESC LIMIT 1";
pub(crate) const STORAGE_SUBSESSIONS_NATIVE_COMPLETION_INDEXED_2: &str =
    "SELECT 1 FROM btcc_subsession_outbox WHERE result_id=?1";
pub(crate) const STORAGE_SUBSESSIONS_NATIVE_COMPLETION_INDEXED_3: &str =
    "UPDATE wm_attempts SET checkpoint_ref=?2 WHERE id=?1";
const ASSIGNMENT: &str = "SELECT i.payload_json,a.id,a.task_id,a.part_id,t.work_id \
 FROM btcc_session_relations r JOIN wm_session_exec s ON s.session_id=r.child_session_id \
 JOIN wm_tasks t ON t.id=s.current_task_id \
 JOIN wm_attempts a ON a.task_id=t.id AND a.session_id=r.child_session_id \
 JOIN wm_cross_db_intents i ON i.op_id='child_dispatch:'||a.id";

pub(crate) fn assignment_read(predicate: &str) -> String {
    format!("{ASSIGNMENT} WHERE {predicate} ORDER BY a.started_at,a.id LIMIT 1")
}

#[cfg(feature = "test-support")]
pub(crate) fn statements() -> Vec<(&'static str, String)> {
    let mut statements: Vec<_> = ALL
        .iter()
        .map(|(name, sql)| (*name, (*sql).to_owned()))
        .collect();
    for (name, sql) in [
        ("WORKER_RUNNING_COUNT", WORKER_RUNNING_COUNT),
        ("WORKER_NEXT_WAITING", WORKER_NEXT_WAITING),
        (
            "SUBSESSIONS_SERVICE_TASK_PART_COUNTS",
            SUBSESSIONS_SERVICE_TASK_PART_COUNTS,
        ),
        ("WORKER_DISPATCH_PENDING", WORKER_DISPATCH_PENDING),
    ] {
        statements.push((name, sql.to_owned()));
    }
    statements.push((
        "SUBSESSIONS_SERVICE_REPORT_CHILD",
        SUBSESSIONS_SERVICE_REPORT_CHILD.to_owned(),
    ));
    statements.push((
        "SUBSESSIONS_SERVICE_WAITING_TURN",
        SUBSESSIONS_SERVICE_WAITING_TURN.to_owned(),
    ));
    statements.push((
        "SUBSESSIONS_SERVICE_LATEST_PART",
        SUBSESSIONS_SERVICE_LATEST_PART.to_owned(),
    ));
    for (name, predicate) in [
        ("ASSIGNMENT_CHILD", "r.child_session_id=?1"),
        ("ASSIGNMENT_RELATION", "r.relation_id=?1"),
        (
            "ASSIGNMENT_DELEGATION",
            "i.op_id='child_dispatch:attempt-'||?1",
        ),
        ("ASSIGNMENT_WORK", "t.work_id=?1"),
    ] {
        statements.push((name, assignment_read(predicate)));
    }
    statements.push((
        "CUTOVER_RECEIPT",
        super::work_model_cutover::admission::RECEIPT.to_owned(),
    ));
    statements.push((
        "CUTOVER_REPLAY_RECEIPT",
        super::work_model_cutover::admission::REPLAY_RECEIPT.to_owned(),
    ));
    statements.push((
        "CUTOVER_WAIT",
        super::work_model_cutover::admission::WAIT.to_owned(),
    ));
    for (name, sql) in [
        (
            "CUTOVER_TRANSCRIPT_TURN",
            super::work_model_cutover::transcript::TURN,
        ),
        (
            "CUTOVER_TRANSCRIPT_ROUNDS",
            super::work_model_cutover::transcript::ROUNDS,
        ),
        (
            "CUTOVER_TRANSCRIPT_TOOLS",
            super::work_model_cutover::transcript::TOOLS,
        ),
    ] {
        statements.push((name, sql.to_owned()));
    }
    statements.extend(
        super::subsessions::native_recovery::sql::ALL
            .iter()
            .map(|(name, sql)| (*name, (*sql).to_owned())),
    );
    statements
}

#[cfg(feature = "test-support")]
const ALL: &[(&str, &str)] = &[
    (
        "STORAGE_SUBSESSIONS_COMPLETION_1",
        STORAGE_SUBSESSIONS_COMPLETION_1,
    ),
    (
        "STORAGE_SUBSESSIONS_COMPLETION_2",
        STORAGE_SUBSESSIONS_COMPLETION_2,
    ),
    (
        "STORAGE_SUBSESSIONS_COMPLETION_3",
        STORAGE_SUBSESSIONS_COMPLETION_3,
    ),
    (
        "STORAGE_SUBSESSIONS_COMPLETION_4",
        STORAGE_SUBSESSIONS_COMPLETION_4,
    ),
    (
        "STORAGE_SUBSESSIONS_COMPLETION_5",
        STORAGE_SUBSESSIONS_COMPLETION_5,
    ),
    (
        "STORAGE_SUBSESSIONS_COMPLETION_6",
        STORAGE_SUBSESSIONS_COMPLETION_6,
    ),
    (
        "STORAGE_SUBSESSIONS_COMPLETION_7",
        STORAGE_SUBSESSIONS_COMPLETION_7,
    ),
    (
        "STORAGE_SUBSESSIONS_DIRECTIONS_1",
        STORAGE_SUBSESSIONS_DIRECTIONS_1,
    ),
    (
        "STORAGE_SUBSESSIONS_DIRECTIONS_2",
        STORAGE_SUBSESSIONS_DIRECTIONS_2,
    ),
    ("STORAGE_SUBSESSIONS_1", STORAGE_SUBSESSIONS_1),
    (
        "SUBSESSIONS_SERVICE_SESSION_CONTROL_1",
        SUBSESSIONS_SERVICE_SESSION_CONTROL_1,
    ),
    (
        "SUBSESSIONS_SERVICE_SESSION_CONTROL_2",
        SUBSESSIONS_SERVICE_SESSION_CONTROL_2,
    ),
    (
        "SUBSESSIONS_SERVICE_SESSION_CONTROL_3",
        SUBSESSIONS_SERVICE_SESSION_CONTROL_3,
    ),
    (
        "SUBSESSIONS_SERVICE_LIFECYCLE_1",
        SUBSESSIONS_SERVICE_LIFECYCLE_1,
    ),
    (
        "SUBSESSIONS_SERVICE_LIFECYCLE_2",
        SUBSESSIONS_SERVICE_LIFECYCLE_2,
    ),
    (
        "SUBSESSIONS_SERVICE_CUTOVER_1",
        SUBSESSIONS_SERVICE_CUTOVER_1,
    ),
    (
        "STORAGE_SUBSESSIONS_NATIVE_INDEXED_1",
        STORAGE_SUBSESSIONS_NATIVE_INDEXED_1,
    ),
    (
        "STORAGE_SUBSESSIONS_NATIVE_INDEXED_2",
        STORAGE_SUBSESSIONS_NATIVE_INDEXED_2,
    ),
    (
        "STORAGE_SUBSESSIONS_NATIVE_INDEXED_3",
        STORAGE_SUBSESSIONS_NATIVE_INDEXED_3,
    ),
    (
        "STORAGE_SUBSESSIONS_NATIVE_INDEXED_4",
        STORAGE_SUBSESSIONS_NATIVE_INDEXED_4,
    ),
    (
        "STORAGE_SUBSESSIONS_NATIVE_INDEXED_5",
        STORAGE_SUBSESSIONS_NATIVE_INDEXED_5,
    ),
    (
        "STORAGE_SUBSESSIONS_INDEXED_1",
        STORAGE_SUBSESSIONS_INDEXED_1,
    ),
    (
        "STORAGE_SUBSESSIONS_INDEXED_2",
        STORAGE_SUBSESSIONS_INDEXED_2,
    ),
    (
        "STORAGE_SUBSESSIONS_INDEXED_3",
        STORAGE_SUBSESSIONS_INDEXED_3,
    ),
    (
        "STORAGE_SUBSESSIONS_INDEXED_4",
        STORAGE_SUBSESSIONS_INDEXED_4,
    ),
    (
        "STORAGE_SUBSESSIONS_INDEXED_5",
        STORAGE_SUBSESSIONS_INDEXED_5,
    ),
    (
        "STORAGE_SUBSESSIONS_INDEXED_6",
        STORAGE_SUBSESSIONS_INDEXED_6,
    ),
    (
        "SUBSESSIONS_SERVICE_ADMISSION_INDEXED_1",
        SUBSESSIONS_SERVICE_ADMISSION_INDEXED_1,
    ),
    (
        "SUBSESSIONS_SERVICE_ADMISSION_INDEXED_2",
        SUBSESSIONS_SERVICE_ADMISSION_INDEXED_2,
    ),
    (
        "SUBSESSIONS_SERVICE_ADMISSION_INDEXED_3",
        SUBSESSIONS_SERVICE_ADMISSION_INDEXED_3,
    ),
    (
        "SUBSESSIONS_SERVICE_ADMISSION_INDEXED_4",
        SUBSESSIONS_SERVICE_ADMISSION_INDEXED_4,
    ),
    (
        "SUBSESSIONS_SERVICE_ADMISSION_INDEXED_5",
        SUBSESSIONS_SERVICE_ADMISSION_INDEXED_5,
    ),
    (
        "SUBSESSIONS_SERVICE_ADMISSION_INDEXED_6",
        SUBSESSIONS_SERVICE_ADMISSION_INDEXED_6,
    ),
    (
        "STORAGE_SUBSESSIONS_NATIVE_COMPLETION_INDEXED_1",
        STORAGE_SUBSESSIONS_NATIVE_COMPLETION_INDEXED_1,
    ),
    (
        "STORAGE_SUBSESSIONS_NATIVE_COMPLETION_INDEXED_2",
        STORAGE_SUBSESSIONS_NATIVE_COMPLETION_INDEXED_2,
    ),
    (
        "STORAGE_SUBSESSIONS_NATIVE_COMPLETION_INDEXED_3",
        STORAGE_SUBSESSIONS_NATIVE_COMPLETION_INDEXED_3,
    ),
];
