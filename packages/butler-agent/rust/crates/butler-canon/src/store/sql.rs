//! Every operational statement is declared here so query-plan coverage is total.
macro_rules! statements {
    ($($name:ident = $sql:literal;)+) => {
        $(pub const $name: &str = $sql;)+
        pub const ALL: &[(&str,&str)] = &[$((stringify!($name),$name)),+];
    }
}
statements! {
BIND_SESSION = "INSERT INTO canon_session_epics(session_id,epic_id,bound_at,bound_by,origin,is_home) VALUES(?1,?2,MAX(?3,COALESCE((SELECT MAX(bound_at)+1 FROM canon_session_epics WHERE epic_id=?2),?3),COALESCE((SELECT MAX(bound_at)+1 FROM canon_session_epics WHERE session_id=?1),?3)),?4,?5,?6 AND NOT EXISTS(SELECT 1 FROM canon_session_epics WHERE epic_id=?2 AND is_home=1)) ON CONFLICT(session_id,epic_id) DO NOTHING";
EPIC_SESSIONS = "SELECT session_id,bound_at,origin,is_home FROM canon_session_epics WHERE epic_id=?1 ORDER BY is_home DESC,bound_at,rowid";
LABEL = "UPDATE canon_epics SET canon_status=?2,canon_status_source='person',revision=revision+1,updated_at=?3 WHERE id=?1 AND revision=?4";
WORK = "SELECT * FROM canon_epics WHERE id=?1";
PLAN = "SELECT * FROM canon_plans WHERE id=?1";
INSERT_PLAN = "INSERT INTO canon_plans(id,project_id,title,description,due_on,status,created_at,updated_at,created_by) VALUES(?1,?2,?3,?4,?5,?6,?7,?7,?8)";
EDIT_PLAN = "UPDATE canon_plans SET title=?2,description=?3,due_on=?4,status=?5,revision=revision+1,updated_at=?6 WHERE id=?1 AND revision=?7";
INSERT_WORK = "INSERT INTO canon_epics(id,project_id,title,description,origin,created_at,updated_at,created_by,assignee) VALUES(?1,?2,?3,?4,?5,?6,?6,?7,?8)";
EDIT_WORK = "UPDATE canon_epics SET title=?2,description=?3,kind=?4,assignee=?5,revision=revision+1,updated_at=?6 WHERE id=?1 AND revision=?7";
RANK = "UPDATE canon_epics SET plan_id=?2,plan_rank=?3,revision=revision+1,updated_at=?4 WHERE id=?1 AND revision=?5";
AUDIT = "INSERT INTO canon_audit(entity_kind,entity_id,revision,actor_json,op,at,payload_json) VALUES(?1,?2,?3,?4,?5,?6,?7)";
OUTBOX = "INSERT INTO canon_events(topic,payload_json,created_at) VALUES(?1,?2,?3)";
COUNT = "INSERT INTO canon_counters(scope_kind,scope_ref,key,count) VALUES(?1,?2,?3,MAX(?4,0)) ON CONFLICT(scope_kind,scope_ref,key) DO UPDATE SET count=count+?4";
INTENT = "SELECT * FROM canon_intents WHERE op_id=?1";
INSERT_INTENT = "INSERT INTO canon_intents(op_id,kind,payload_json,state,created_at) VALUES(?1,?2,?3,'pending',?4) ON CONFLICT(op_id) DO NOTHING";
PENDING_INTENTS = "SELECT * FROM canon_intents WHERE state='pending' AND op_id>?1 ORDER BY op_id LIMIT ?2";
APPLY_INTENT = "UPDATE canon_intents SET state='applied',revision=revision+1 WHERE op_id=?1 AND revision=?2";
NODE = "SELECT * FROM canon_spec_nodes WHERE node_id=?1";
INSERT_NODE = "INSERT INTO canon_spec_nodes(node_id,scope_kind,scope_ref,epic_id,parent_node_id,concern_id,visibility,lifecycle,source,created_at,updated_at,created_by) VALUES(?1,?2,?3,?4,?5,?6,?7,'draft','local',?8,?8,?9)";
BODY = "SELECT hash,bytes FROM canon_spec_bodies WHERE hash=?1";
PUT_BODY = "INSERT INTO canon_spec_bodies(hash,body,bytes) VALUES(?1,?2,?3) ON CONFLICT(hash) DO NOTHING";
SPEC_REVISION = "SELECT * FROM canon_spec_revisions WHERE node_id=?1 AND revision=?2";
PUBLISH = "INSERT INTO canon_spec_revisions(node_id,revision,body_hash,parser_version,state) VALUES(?1,?2,?3,?4,'published')";
CRITERION = "INSERT INTO canon_spec_criteria(node_id,revision,criterion_id,part_id,text) VALUES(?1,?2,?3,?4,?5)";
NODE_BUMP = "UPDATE canon_spec_nodes SET revision=revision+1,updated_at=?2 WHERE node_id=?1 AND revision=?3";
ACTIVATE = "UPDATE canon_spec_nodes SET active_revision=?2,lifecycle='active',revision=revision+1,updated_at=?3 WHERE node_id=?1 AND revision=?4 AND active_revision IS ?5";
SPEC_STATE = "UPDATE canon_spec_revisions SET state=?3 WHERE node_id=?1 AND revision=?2";
}
