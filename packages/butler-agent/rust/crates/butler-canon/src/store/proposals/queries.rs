//! Explicit indexes also pin request-path query plans.
pub const GET: &str =
    "SELECT * FROM canon_proposals INDEXED BY sqlite_autoindex_canon_proposals_1 WHERE id=?1";
pub const OPEN_SESSION: &str = "SELECT * FROM canon_proposals INDEXED BY canon_proposals_open_session WHERE session_id=?1 AND state='open' ORDER BY created_at DESC";
pub const OPEN_PAGE: &str = "SELECT * FROM canon_proposals INDEXED BY canon_proposals_chat_open WHERE state='open' AND source='chat' ORDER BY created_at DESC,id DESC LIMIT ?1";
pub const OPEN_BEFORE: &str = "SELECT * FROM canon_proposals INDEXED BY canon_proposals_chat_open WHERE state='open' AND source='chat' AND created_at<=?1 AND (created_at<?1 OR 'canon:'||id<?2) ORDER BY created_at DESC,id DESC LIMIT ?3";
pub const TURN: &str = "SELECT id FROM canon_proposals INDEXED BY canon_proposals_turn WHERE source_turn_id=?1 ORDER BY created_at,id";
pub const COUNT: &str = "SELECT COUNT(*) FROM canon_proposals INDEXED BY canon_proposals_open_session WHERE session_id=?1 AND state='open'";
pub const PROJECT_SPECS: &str = "SELECT * FROM canon_spec_nodes INDEXED BY canon_spec_nodes_shared_project WHERE scope_kind='project' AND visibility='canon' AND scope_ref=?1 ORDER BY node_id";
pub const INSERT: &str = "INSERT INTO canon_proposals(id,session_id,source_turn_id,source_call_id,project_id,summary,changes_json,state,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,'open',?8)";
pub const RESOLVE: &str = "UPDATE canon_proposals SET state=?2,resolved_by=?3,resolved_at=?4 WHERE id=?1 AND state='open'";
