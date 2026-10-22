//! Indexed statements for Task execution and hidden part edits.
macro_rules! statements {
    ($($name:ident = $sql:literal;)+) => {
        $(pub const $name: &str = $sql;)+
        pub const ALL: &[(&str,&str)] = &[$((stringify!($name),$name)),+];
    }
}
statements! {
PART = "SELECT * FROM wm_task_parts WHERE id=?1";
PARTS = "SELECT * FROM wm_task_parts WHERE task_id=?1 ORDER BY part_rank,id";
PART_EDGES = "SELECT pred,succ FROM wm_task_part_edges WHERE task_id=?1";
INSERT_PART = "INSERT INTO wm_task_parts(id,task_id,kind,title,status,part_rank) VALUES(?1,?2,?3,?4,'pending',?5)";
EDIT_PART = "UPDATE wm_task_parts SET title=?2,revision=revision+1 WHERE id=?1 AND revision=?3";
PART_STATE = "UPDATE wm_task_parts SET status=?2,assignee_session_id=coalesce(?3,assignee_session_id),revision=revision+1 WHERE id=?1";
REMOVE_PART_EDGES = "DELETE FROM wm_task_part_edges WHERE task_id=?1 AND (pred=?2 OR succ=?2)";
REMOVE_PART_PREDS = "DELETE FROM wm_task_part_edges WHERE task_id=?1 AND succ=?2";
INSERT_PART_EDGE = "INSERT INTO wm_task_part_edges(task_id,pred,succ) VALUES(?1,?2,?3)";
TASK_OWNER = "UPDATE wm_tasks SET assignee_session_id=?2 WHERE id=?1";
TASK_REASON = "UPDATE wm_tasks SET blocked_reason=?2 WHERE id=?1";
TASK_COMPLETION = "UPDATE wm_tasks SET completion_revision=?2 WHERE id=?1";
CRITERIA = "SELECT node_id,node_revision,criterion_id FROM wm_task_criteria WHERE task_id=?1 ORDER BY node_id,node_revision,criterion_id";
DELETE_CRITERIA = "DELETE FROM wm_task_criteria WHERE task_id=?1";
INSERT_CRITERION = "INSERT INTO wm_task_criteria(task_id,node_id,node_revision,criterion_id) VALUES(?1,?2,?3,?4)";
CRITERION = "SELECT c.*,n.work_id,n.active_revision FROM wm_spec_criteria c JOIN wm_spec_nodes n ON n.node_id=c.node_id WHERE c.node_id=?1 AND c.revision=?2 AND c.criterion_id=?3";
EDIT_TASK = "UPDATE wm_tasks SET title=?2,description=?3,status=?4,revision=revision+1,updated_at=?5 WHERE id=?1 AND revision=?6";
WORK_SPEC = "UPDATE wm_works SET spec_node_id=?2,tier=?3 WHERE id=?1";
INSTRUCTION = "SELECT id FROM wm_instructions WHERE id=?1 AND target_session_id=?2";
ATTEMPTS = "SELECT * FROM wm_attempts WHERE task_id=?1 ORDER BY started_at,id";
LEASE = "SELECT * FROM wm_attempts WHERE task_id=?1 AND status='running' AND part_id IS NULL";
PART_LEASE = "SELECT * FROM wm_attempts WHERE part_id=?1 AND status='running' AND part_id IS NOT NULL";
INSERT_ATTEMPT = "INSERT INTO wm_attempts(id,task_id,part_id,task_revision,spec_ref,session_id,turn_id,lease_epoch,status,started_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?4,'running',?8)";
FINISH_ATTEMPT = "UPDATE wm_attempts SET status=?2,finished_at=?3,checkpoint_ref=?4,revision=revision+1 WHERE id=?1 AND status='running'";
FINISH_TASK_ATTEMPTS = "UPDATE wm_attempts SET status=?2,finished_at=?3,checkpoint_ref=?4,revision=revision+1 WHERE task_id=?1 AND status='running'";
RESULTS = "SELECT * FROM wm_results WHERE task_id=?1 ORDER BY revision DESC";
LATEST_RESULT = "SELECT * FROM wm_results WHERE task_id=?1 ORDER BY revision DESC LIMIT 1";
INSERT_RESULT = "INSERT INTO wm_results(id,revision,task_id,task_revision,attempt_id,spec_ref,body_ref,criterion_results_json,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,'[]',?8)";
REVIEW = "SELECT * FROM wm_reviews WHERE id=?1";
INSERT_REVIEW = "INSERT INTO wm_reviews(id,task_id,task_revision,spec_ref,result_id,result_revision,reviewer,criterion_results_json,verdict,at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)";
}
