//! Indexed, session-bound reads for the model-facing Work surface.
macro_rules! statements {
    ($($name:ident = $sql:literal;)+) => {
        $(pub const $name: &str = $sql;)+
        pub const ALL: &[(&str,&str)] = &[$((stringify!($name),$name)),+];
    }
}
statements! {
HOME = "SELECT * FROM wm_works WHERE home_session_id=?1 ORDER BY updated_at DESC,id LIMIT 1";
CURRENT = "SELECT t.work_id FROM wm_session_exec s JOIN wm_tasks t ON t.id=s.current_task_id WHERE s.session_id=?1";
PART_WORK = "SELECT t.work_id FROM wm_task_parts p JOIN wm_tasks t ON t.id=p.task_id WHERE p.assignee_session_id=?1 ORDER BY p.part_rank,p.id LIMIT 1";
OWNED_TASK = "SELECT id FROM wm_tasks WHERE assignee_session_id=?1 AND work_id=?2 LIMIT 1";
OWNED_PART = "SELECT p.id FROM wm_task_parts p JOIN wm_tasks t ON t.id=p.task_id WHERE p.assignee_session_id=?1 AND t.work_id=?2 LIMIT 1";
BODY = "SELECT body FROM wm_spec_bodies WHERE hash=?1";
REVIEWS = "SELECT * FROM wm_reviews WHERE task_id=?1 ORDER BY at,id";
}
