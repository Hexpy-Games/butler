//! All new operational SQL is covered by query-plan pins.
macro_rules! statements {
    ($($name:ident = $sql:literal;)+) => {
        $(pub const $name: &str = $sql;)+
        pub const ALL: &[(&str,&str)] = &[$((stringify!($name),$name)),+];
    }
}
statements! {
PLAN_SCOPE = "SELECT project_id FROM wm_plans WHERE id=?1 AND visibility='canon'";
EPIC_SCOPE = "SELECT scope_ref FROM wm_works WHERE id=?1 AND visibility='canon'";
CHAINS = "SELECT * FROM wm_work_chains WHERE session_id=?1 ORDER BY created_at,id";
PLANS = "SELECT * FROM wm_plans WHERE project_id=?1 AND visibility='canon' ORDER BY status DESC,due_on IS NULL,due_on,created_at,id";
BACKLOG_REVISION = "SELECT count AS revision FROM wm_counts WHERE scope_kind='project' AND scope_ref=?1 AND key='backlog_revision'";
BUMP_BACKLOG = "INSERT INTO wm_counts(scope_kind,scope_ref,key,count) VALUES('project',?1,'backlog_revision',1) ON CONFLICT(scope_kind,scope_ref,key) DO UPDATE SET count=count+1";
BUMP_PLAN = "UPDATE wm_plans SET revision=revision+1,updated_at=?2 WHERE id=?1";
SPEC_CRITERIA = "SELECT * FROM wm_spec_criteria WHERE node_id=?1 AND revision=?2 ORDER BY criterion_id";
PUBLISHED = "UPDATE wm_outbox SET published=1 WHERE seq=?1 AND published=0";
}
