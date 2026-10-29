//! All new operational SQL is covered by query-plan pins.
macro_rules! statements {
    ($($name:ident = $sql:literal;)+) => {
        $(pub const $name: &str = $sql;)+
        pub const ALL: &[(&str,&str)] = &[$((stringify!($name),$name)),+];
    }
}
statements! {
OPEN_MCP_SPEC = "SELECT * FROM canon_proposals INDEXED BY canon_proposals_mcp_spec WHERE json_extract(changes_json,'$[0].id')=?1 AND source='mcp' AND state='open' ORDER BY created_at DESC,id DESC";
PLAN_SCOPE = "SELECT project_id FROM canon_plans WHERE id=?1";
EPIC_SCOPE = "SELECT project_id FROM canon_epics WHERE id=?1";
PLANS = "SELECT * FROM canon_plans WHERE project_id=?1 ORDER BY status DESC,due_on IS NULL,due_on,created_at,id";
BACKLOG_REVISION = "SELECT count AS revision FROM canon_counters WHERE scope_kind='project' AND scope_ref=?1 AND key='backlog_revision'";
BUMP_BACKLOG = "INSERT INTO canon_counters(scope_kind,scope_ref,key,count) VALUES('project',?1,'backlog_revision',1) ON CONFLICT(scope_kind,scope_ref,key) DO UPDATE SET count=count+1";
BUMP_PLAN = "UPDATE canon_plans SET revision=revision+1,updated_at=?2 WHERE id=?1";
SPEC_CRITERIA = "SELECT * FROM canon_spec_criteria WHERE node_id=?1 AND revision=?2 ORDER BY criterion_id";
TAG_SCOPE = "SELECT project_id FROM canon_tags WHERE id=?1";
TAGS = "SELECT * FROM canon_tags WHERE project_id=?1 ORDER BY name_key";
TAG = "SELECT * FROM canon_tags WHERE id=?1";
TAG_NAME = "SELECT * FROM canon_tags WHERE project_id=?1 AND name_key=?2";
INSERT_TAG = "INSERT INTO canon_tags(id,project_id,name,name_key,color,created_at,updated_at,created_by) VALUES(?1,?2,?3,?4,?5,?6,?6,?7)";
EDIT_TAG = "UPDATE canon_tags SET name=?2,name_key=?3,color=?4,revision=revision+1,updated_at=?5 WHERE id=?1 AND revision=?6";
DELETE_TAG = "DELETE FROM canon_tags WHERE id=?1";
EPIC_TAGS = "SELECT t.id,t.name,t.color FROM canon_epic_tags a JOIN canon_tags t ON t.id=a.tag_id WHERE a.epic_id=?1 ORDER BY t.name_key";
TAG_EPICS = "SELECT e.id,e.revision FROM canon_epic_tags a JOIN canon_epics e ON e.id=a.epic_id WHERE a.tag_id=?1 ORDER BY a.epic_id";
CLEAR_TAGS = "DELETE FROM canon_epic_tags WHERE epic_id=?1";
ASSIGN_TAG = "INSERT INTO canon_epic_tags(epic_id,tag_id) VALUES(?1,?2) ON CONFLICT DO NOTHING";
BUMP_EPIC = "UPDATE canon_epics SET revision=revision+1,updated_at=?2 WHERE id=?1 AND revision=?3";
PUBLISHED = "UPDATE canon_events SET published=1 WHERE seq=?1 AND published=0";
}
