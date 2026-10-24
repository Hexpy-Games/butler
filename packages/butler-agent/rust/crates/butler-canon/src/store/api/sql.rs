//! All new operational SQL is covered by query-plan pins.
macro_rules! statements {
    ($($name:ident = $sql:literal;)+) => {
        $(pub const $name: &str = $sql;)+
        pub const ALL: &[(&str,&str)] = &[$((stringify!($name),$name)),+];
    }
}
statements! {
PLAN_SCOPE = "SELECT project_id FROM canon_plans WHERE id=?1";
EPIC_SCOPE = "SELECT project_id FROM canon_epics WHERE id=?1";
PLANS = "SELECT * FROM canon_plans WHERE project_id=?1 ORDER BY status DESC,due_on IS NULL,due_on,created_at,id";
BACKLOG_REVISION = "SELECT count AS revision FROM canon_counters WHERE scope_kind='project' AND scope_ref=?1 AND key='backlog_revision'";
BUMP_BACKLOG = "INSERT INTO canon_counters(scope_kind,scope_ref,key,count) VALUES('project',?1,'backlog_revision',1) ON CONFLICT(scope_kind,scope_ref,key) DO UPDATE SET count=count+1";
BUMP_PLAN = "UPDATE canon_plans SET revision=revision+1,updated_at=?2 WHERE id=?1";
SPEC_CRITERIA = "SELECT * FROM canon_spec_criteria WHERE node_id=?1 AND revision=?2 ORDER BY criterion_id";
PUBLISHED = "UPDATE canon_events SET published=1 WHERE seq=?1 AND published=0";
}
