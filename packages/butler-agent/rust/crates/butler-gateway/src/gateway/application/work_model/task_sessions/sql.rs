//! App projection statements, shared by production and query-plan pins.
macro_rules! statements {
    ($($name:ident = $sql:literal;)+) => {
        $(pub(in crate::gateway::application) const $name: &str = $sql;)+
        #[cfg(feature = "test-support")]
        pub(in crate::gateway::application) const ALL: &[(&str,&str)] = &[$((stringify!($name),$name)),+];
    }
}
statements! {
PROJECTED = "SELECT EXISTS(SELECT 1 FROM app_task_sessions WHERE op_id=?1)";
CHAT_EXISTS = "SELECT EXISTS(SELECT 1 FROM chats WHERE id=?1)";
COORDINATOR_PROJECT = "SELECT project_id FROM chats WHERE id=?1";
BIND_CHAT = "UPDATE chats SET runtime_session_hint=?1 WHERE id=?1";
REMOVE_NODE = "DELETE FROM app_space_nodes WHERE node_key='s:'||?1";
INSERT_SESSION = "INSERT INTO app_task_sessions(session_id,task_id,work_id,op_id) VALUES(?1,?2,?3,?4)";
CHAT_TITLE = "SELECT title FROM chats WHERE id=?1";
INSERT_PROMPT = "INSERT OR IGNORE INTO app_session_decisions(id,session_id,task_id,payload_json) VALUES(?1,?2,?3,?4)";
PENDING_PROMPTS = "SELECT id,payload_json FROM app_session_decisions WHERE session_id=?1 AND decision IS NULL ORDER BY id";
RESOLVE_PROMPT = "UPDATE app_session_decisions SET decision='take_here' WHERE session_id=?1 AND task_id=?2 AND decision IS NULL";
LOOKUP_SESSION = "SELECT session_id FROM app_task_sessions WHERE session_id=?1";
}
