//! Indexed ownership statements, also exercised by the execution plan pins.
macro_rules! statements {
    ($($name:ident = $sql:literal;)+) => {
        $(pub const $name: &str = $sql;)+
        pub const ALL: &[(&str,&str)] = &[$((stringify!($name),$name)),+];
    }
}
statements! {
PENDING_PROJECTIONS = "SELECT * FROM wm_cross_db_intents WHERE kind IN ('task_session_chat','ownership_prompt','ownership_taken','task_continue') AND state='pending' ORDER BY kind,op_id";
PENDING_CONTROLS = "SELECT op_id,kind,payload_json FROM wm_cross_db_intents WHERE kind='handoff_stop' AND state='pending' ORDER BY kind,op_id";
RESERVE = "UPDATE wm_tasks SET reserved_session_id=?2,assignee_session_id=?3,owner_epoch=CASE WHEN ?3 IS NULL THEN 0 ELSE 1 END WHERE id=?1";
START_WORK = "UPDATE wm_works SET started_at=coalesce(started_at,?2) WHERE id=?1";
STALE_OWNER = "SELECT EXISTS(SELECT 1 FROM wm_attempts a JOIN wm_tasks t ON t.id=a.task_id WHERE a.task_id=?1 AND a.session_id=?2 AND a.owner_epoch<>t.owner_epoch) AND NOT EXISTS(SELECT 1 FROM wm_attempts a JOIN wm_tasks t ON t.id=a.task_id WHERE a.task_id=?1 AND a.session_id=?2 AND a.owner_epoch=t.owner_epoch AND a.status='running')";

TAKE_RESERVED = "UPDATE wm_tasks SET assignee_session_id=?2,reserved_session_id=NULL,owner_epoch=owner_epoch+1,revision=revision+1,updated_at=?3 WHERE id=?1 AND revision=?4 AND handoff_to_session_id IS NULL AND status IN ('pending','waiting','blocked','paused','stopped')";
BEGIN_HANDOFF = "UPDATE wm_tasks SET handoff_to_session_id=?2,revision=revision+1,updated_at=?3 WHERE id=?1 AND revision=?4 AND handoff_to_session_id IS NULL AND status IN ('running','in_review')";
MOVE_OWNER = "UPDATE wm_tasks SET assignee_session_id=?2,reserved_session_id=NULL,owner_epoch=owner_epoch+1,handoff_to_session_id=NULL,revision=revision+1,updated_at=?3 WHERE id=?1 AND revision=?4 AND handoff_to_session_id=?2 AND owner_epoch=?5";
HOLD_REASON = "UPDATE wm_holds SET reason='handoff' WHERE id=?1";
HANDOFF_PENDING = "SELECT * FROM wm_tasks WHERE handoff_to_session_id IS NOT NULL AND id>?1 ORDER BY id";
LATEST_CHECKPOINT = "SELECT checkpoint_ref FROM wm_attempts WHERE task_id=?1 AND checkpoint_ref IS NOT NULL ORDER BY started_at DESC,id DESC LIMIT 1";
}
