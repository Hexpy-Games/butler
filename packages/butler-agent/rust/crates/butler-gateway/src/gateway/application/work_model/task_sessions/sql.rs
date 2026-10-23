//! App projection statements, shared by production and query-plan pins.
macro_rules! statements {
    ($($name:ident = $sql:literal;)+) => {
        $(pub(in crate::gateway::application) const $name: &str = $sql;)+
        #[cfg(feature = "test-support")]
        pub(in crate::gateway::application) const ALL: &[(&str,&str)] = &[$((stringify!($name),$name)),+];
    }
}
statements! {
INPUT_ROLE = "SELECT CASE WHEN json_type(control_resolution_json,'$.runtime_instruction_id')='text' THEN 'system' ELSE 'user' END FROM session_queued_messages WHERE id=?1";
PROJECTED = "SELECT EXISTS(SELECT 1 FROM app_task_sessions WHERE op_id=?1)";
CHAT_EXISTS = "SELECT EXISTS(SELECT 1 FROM chats WHERE id=?1)";
COORDINATOR_PROJECT = "SELECT project_id FROM chats WHERE id=?1";
BIND_CHAT = "UPDATE chats SET runtime_session_hint=?1 WHERE id=?1";
REMOVE_NODE = "DELETE FROM app_space_nodes WHERE node_key='s:'||?1";
INSERT_SESSION = "INSERT INTO app_task_sessions(session_id,task_id,work_id,op_id,coordinator_session_id) VALUES(?1,?2,?3,?4,?5)";
NESTED_SESSIONS = "SELECT s.session_id,s.task_id,s.work_id,c.id AS coordinator_session_id,t.title FROM json_each(?1) j CROSS JOIN chats c ON c.id=j.value CROSS JOIN app_task_sessions s INDEXED BY app_task_sessions_coordinator ON s.coordinator_session_id=c.id CROSS JOIN chats t ON t.id=s.session_id ORDER BY c.id,s.task_id,s.session_id";
UNBOUND_SESSIONS = "SELECT session_id FROM app_task_sessions WHERE coordinator_session_id IS NULL";
BIND_COORDINATOR = "UPDATE app_task_sessions SET coordinator_session_id=(SELECT id FROM chats WHERE runtime_session_hint=?2) WHERE session_id=?1 AND coordinator_session_id IS NULL";
}
