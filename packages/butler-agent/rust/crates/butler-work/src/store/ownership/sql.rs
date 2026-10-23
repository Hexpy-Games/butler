//! Indexed ownership statements, also exercised by the execution plan pins.
macro_rules! statements {
    ($($name:ident = $sql:literal;)+) => {
        $(pub const $name: &str = $sql;)+
        pub const ALL: &[(&str,&str)] = &[$((stringify!($name),$name)),+];
    }
}
statements! {
PENDING_PROJECTIONS = "SELECT * FROM wm_cross_db_intents WHERE kind IN ('task_session_chat','task_continue') AND state='pending' ORDER BY kind,op_id";
PENDING_CONTROLS = "SELECT op_id,kind,payload_json FROM wm_cross_db_intents WHERE kind='handoff_stop' AND state='pending' ORDER BY kind,op_id";
STARTUP_READY = "SELECT id FROM wm_works WHERE started_at IS NOT NULL AND run_state IN ('idle','running','in_review','blocked','failed') ORDER BY run_state,id";
READY_CHANGED = "INSERT INTO wm_cross_db_intents(op_id,kind,payload_json,state,created_at) VALUES(?1,'ready_start',json_object('work_id',?2),'pending',?3) ON CONFLICT(op_id) DO UPDATE SET state='pending',revision=revision+1";
SESSION_STATES = "SELECT r.value AS session_id,t.id AS task_id,t.work_id,t.title,t.status,w.home_session_id,t.chain_id,t.step_index,t.stack_position,c.created_at AS chain_created_at FROM json_each(?1) r JOIN wm_cross_db_intents i ON json_extract(i.payload_json,'$.session_id')=r.value AND i.kind='task_session_chat' JOIN wm_tasks t ON t.id=json_extract(i.payload_json,'$.task_id') JOIN wm_works w ON w.id=t.work_id LEFT JOIN wm_task_chains c ON c.id=t.chain_id";
RUNTIME_INSTRUCTION = "SELECT id,body_ref,status FROM wm_instructions WHERE id=?1 AND target_session_id=?2 AND json_type(sender,'$.runtime')='text'";
RESERVE = "UPDATE wm_tasks SET reserved_session_id=?2,assignee_session_id=?3,owner_epoch=CASE WHEN ?3 IS NULL THEN 0 ELSE 1 END WHERE id=?1";
PERSON_REQUEST = "SELECT EXISTS(SELECT 1 FROM wm_instructions WHERE id=?1 AND json_type(sender,'$.user')='object')";
START_WORK = "UPDATE wm_works SET started_at=coalesce(started_at,?2) WHERE id=?1";
STALE_OWNER = "SELECT EXISTS(SELECT 1 FROM wm_attempts a JOIN wm_tasks t ON t.id=a.task_id WHERE a.task_id=?1 AND a.session_id=?2 AND a.owner_epoch<>t.owner_epoch) AND NOT EXISTS(SELECT 1 FROM wm_attempts a JOIN wm_tasks t ON t.id=a.task_id WHERE a.task_id=?1 AND a.session_id=?2 AND a.owner_epoch=t.owner_epoch AND a.status='running')";

TAKE_RESERVED = "UPDATE wm_tasks SET assignee_session_id=?2,reserved_session_id=NULL,owner_epoch=owner_epoch+1,revision=revision+1,updated_at=?3 WHERE id=?1 AND revision=?4 AND owner_epoch=?5 AND handoff_to_session_id IS NULL AND status IN ('pending','waiting','blocked','paused','stopped')";
BEGIN_HANDOFF = "UPDATE wm_tasks SET handoff_to_session_id=?2,revision=revision+1,updated_at=?3 WHERE id=?1 AND revision=?4 AND owner_epoch=?5 AND handoff_to_session_id IS NULL AND status IN ('running','in_review')";
MOVE_OWNER = "UPDATE wm_tasks SET assignee_session_id=?2,reserved_session_id=NULL,owner_epoch=owner_epoch+1,handoff_to_session_id=NULL,revision=revision+1,updated_at=?3 WHERE id=?1 AND revision=?4 AND handoff_to_session_id=?2 AND owner_epoch=?5";
CLEAR_HANDOFF = "UPDATE wm_tasks SET handoff_to_session_id=NULL WHERE id=?1";
HOLD_REASON = "UPDATE wm_holds SET reason='handoff' WHERE id=?1";
HANDOFF_PENDING = "SELECT * FROM wm_tasks WHERE handoff_to_session_id IS NOT NULL AND id>?1 ORDER BY id";
LATEST_CHECKPOINT = "SELECT checkpoint_ref FROM wm_attempts WHERE task_id=?1 AND checkpoint_ref IS NOT NULL ORDER BY started_at DESC,id DESC LIMIT 1";
}
