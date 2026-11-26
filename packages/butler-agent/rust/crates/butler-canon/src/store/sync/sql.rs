//! Canon online sync statements; every one is covered by the query-plan pin.
macro_rules! statements {
    ($($name:ident = $sql:literal;)+) => {
        $(pub const $name: &str = $sql;)+
        pub const ALL: &[(&str,&str)] = &[$((stringify!($name),$name)),+];
    }
}
statements! {
LINK = "SELECT * FROM canon_space_links WHERE project_id=?1";
LINK_BY_SPACE = "SELECT * FROM canon_space_links WHERE space_id=?1";
INSERT_LINK = "INSERT INTO canon_space_links(project_id,space_id,account_id,role,cursor_seq,state,linked_at) VALUES(?1,?2,?3,?4,?5,'linked',?6)";
SET_CURSOR = "UPDATE canon_space_links SET cursor_seq=?2 WHERE space_id=?1";
SET_STATE = "UPDATE canon_space_links SET state=?2 WHERE space_id=?1";
SET_ROLE = "UPDATE canon_space_links SET role=?2 WHERE space_id=?1";
SET_RESYNC_PENDING = "UPDATE canon_space_links SET resync_pending=?2 WHERE space_id=?1";
DELETE_LINK = "DELETE FROM canon_space_links WHERE project_id=?1";
ENTITY = "SELECT * FROM canon_sync_entities WHERE entity_id=?1 AND project_id=?2";
ENTITY_OWNER = "SELECT project_id FROM canon_sync_entities WHERE entity_id=?1";
ENTITY_BY_KEY = "SELECT * FROM canon_sync_entities WHERE kind=?1 AND local_key=?2 AND project_id=?3";
EPIC_TAG_ENTITIES = "SELECT * FROM canon_sync_entities WHERE parent_id=?1 AND kind='epic_tag' AND project_id=?2";
PAIR_ENTITIES = "SELECT * FROM canon_sync_entities WHERE parent_id=?1 AND kind='epic_tag' AND project_id=?3 AND json_extract(data_json,'$.tag_id')=?2";
DELETE_CHILD_ENTITIES = "DELETE FROM canon_sync_entities WHERE parent_id=?1 AND project_id=?2";
DELETE_UNACKED_ENTITIES = "DELETE FROM canon_sync_entities WHERE project_id=?1 AND sync_revision=0";
PUT_ENTITY = "INSERT INTO canon_sync_entities(entity_id,project_id,kind,local_key,parent_id,sync_revision,data_json) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(entity_id) DO UPDATE SET sync_revision=excluded.sync_revision,data_json=excluded.data_json";
SET_ENTITY_DATA = "UPDATE canon_sync_entities SET data_json=?2 WHERE entity_id=?1 AND project_id=?3";
RAISE_SYNC_REVISION = "UPDATE canon_sync_entities SET sync_revision=MAX(sync_revision,?2) WHERE entity_id=?1 AND project_id=?3";
DELETE_ENTITY = "DELETE FROM canon_sync_entities WHERE entity_id=?1 AND project_id=?2";
DELETE_ENTITY_IF_UNACKED = "DELETE FROM canon_sync_entities WHERE entity_id=?1 AND project_id=?2 AND sync_revision=0";
DELETE_PROJECT_ENTITIES = "DELETE FROM canon_sync_entities WHERE project_id=?1";
OUTBOX_INSERT = "INSERT INTO canon_sync_outbox(op_id,space_id,entity_id,kind,action,fields_json,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)";
OUTBOX_QUEUE = "SELECT * FROM canon_sync_outbox WHERE space_id=?1 AND acked_seq IS NULL ORDER BY seq LIMIT ?2";
OUTBOX_ENTITY = "SELECT * FROM canon_sync_outbox WHERE entity_id=?1 AND space_id=?2 ORDER BY seq";
OUTBOX_ENTITY_ACKED = "SELECT 1 FROM canon_sync_outbox WHERE entity_id=?1 AND space_id=?2 AND acked_seq IS NOT NULL LIMIT 1";
OUTBOX_OP = "SELECT * FROM canon_sync_outbox WHERE op_id=?1 AND space_id=?2";
OUTBOX_SET_BASE = "UPDATE canon_sync_outbox SET base_revision=?2 WHERE op_id=?1";
OUTBOX_SET_FIELDS = "UPDATE canon_sync_outbox SET fields_json=?2 WHERE op_id=?1";
OUTBOX_ACK = "UPDATE canon_sync_outbox SET acked_seq=?2 WHERE op_id=?1";
OUTBOX_DELETE = "DELETE FROM canon_sync_outbox WHERE op_id=?1";
OUTBOX_DELETE_ENTITY = "DELETE FROM canon_sync_outbox WHERE entity_id=?1 AND space_id=?2";
OUTBOX_DELETE_SPACE = "DELETE FROM canon_sync_outbox WHERE space_id=?1";
OUTBOX_DELETE_ACKED = "DELETE FROM canon_sync_outbox WHERE space_id=?1 AND acked_seq IS NOT NULL";
OUTBOX_PENDING = "SELECT COUNT(*) AS n FROM canon_sync_outbox WHERE space_id=?1 AND acked_seq IS NULL";
PROJECT_USED = "SELECT EXISTS(SELECT 1 FROM canon_plans WHERE project_id=?1) OR EXISTS(SELECT 1 FROM canon_epics WHERE project_id=?1) OR EXISTS(SELECT 1 FROM canon_tags WHERE project_id=?1) AS used";
EXPORT_PLANS = "SELECT id FROM canon_plans WHERE project_id=?1";
EXPORT_TAGS = "SELECT id FROM canon_tags WHERE project_id=?1";
EXPORT_EPICS = "SELECT id FROM canon_epics WHERE project_id=?1";
EXPORT_COMMENTS = "SELECT a.seq,a.entity_id,a.body FROM canon_epics e JOIN canon_activity a ON a.entity_id=e.id WHERE e.project_id=?1 AND a.kind='comment' ORDER BY a.seq";
EPIC_TAG_IDS = "SELECT tag_id FROM canon_epic_tags WHERE epic_id=?1";
INSERT_EPIC = "INSERT INTO canon_epics(id,project_id,plan_id,title,description,canon_status,assignee,plan_rank,origin,created_at,updated_at,created_by) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'board',?9,?9,?10)";
UNLINK_TAG = "DELETE FROM canon_epic_tags WHERE epic_id=?1 AND tag_id=?2";
DELETE_COMMENT = "DELETE FROM canon_activity WHERE seq=?1 AND kind='comment'";
CLEAR_PLAN = "UPDATE canon_epics SET plan_id=NULL,revision=revision+1,updated_at=?2 WHERE id=?1";
}

/// Reads the whole link table, one row per linked project, for the status view.
/// This is the one deliberate full read.
pub const LINKS: &str = "SELECT * FROM canon_space_links ORDER BY linked_at";
/// Remote plan delete only (no local plan delete exists in phase 1). Its
/// foreign-key check scans `canon_session_queue_chains`, so it is not pinned.
/// That FK is ON DELETE SET NULL: it also clears `canon_session_queue_chains.plan_id`.
pub const DELETE_PLAN: &str = "DELETE FROM canon_plans WHERE id=?1";
