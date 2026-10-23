//! Indexed startup reconciliation statements.
pub(super) const RECOVERY_1: &str = "SELECT d.delegation_id,r.child_session_id FROM btcc_subsession_delegations d INDEXED BY idx_btcc_legacy_dispatch_recovery JOIN btcc_session_relations r ON r.relation_id=d.relation_id WHERE d.dispatch_state='pending' AND NOT EXISTS(SELECT 1 FROM wm_legacy_map m WHERE m.source='delegation_recovery' AND m.source_id=d.delegation_id) AND NOT EXISTS(SELECT 1 FROM wm_cross_db_intents i WHERE i.op_id='child_dispatch:attempt-'||d.delegation_id) ORDER BY d.created_at,d.delegation_id";
pub(super) const RECOVERY_2: &str = "SELECT x.rowid,x.result_id,x.child_session_id,x.child_turn_id,x.status,x.summary,x.acceptance_evidence_json,x.created_at FROM btcc_steward_results x WHERE x.rowid>?1 AND NOT EXISTS(SELECT 1 FROM wm_legacy_map m WHERE m.source='result_recovery' AND m.source_id=x.result_id) ORDER BY x.rowid LIMIT 128";
pub(super) const RECOVERY_3: &str = "SELECT r.relation_id,r.parent_session_id,r.parent_turn_id,r.safe_title,r.created_at,coalesce(r.activity_role,CASE WHEN r.child_session_id LIKE 'worker-%' THEN 'worker' ELSE 'steward' END) FROM btcc_session_relations r JOIN btcc_subsession_delegations d ON d.relation_id=r.relation_id JOIN wm_legacy_map m ON m.source='delegation_recovery' AND m.source_id=d.delegation_id WHERE r.child_session_id=?1 AND m.batch='unresolved'";
pub(super) const RECOVERY_4: &str =
    "SELECT new_id FROM wm_legacy_map WHERE source='delegation' AND source_id=?1";
pub(super) const RECOVERY_5: &str = "INSERT INTO wm_legacy_map(source,source_id,new_id,source_hash,imported_revision,batch) VALUES('delegation_recovery',?1,?2,'',0,'assigned') ON CONFLICT(source,source_id) DO NOTHING";
pub(super) const RECOVERY_6: &str = "INSERT INTO wm_legacy_map(source,source_id,new_id,source_hash,imported_revision,batch) VALUES('delegation_recovery',?1,'','',0,'unresolved') ON CONFLICT(source,source_id) DO NOTHING";
pub(super) const RECOVERY_7: &str = "UPDATE btcc_session_relations SET activity_terminal=1 WHERE relation_id=(SELECT relation_id FROM btcc_subsession_delegations WHERE delegation_id=?1)";
pub(super) const RECOVERY_8: &str = "SELECT id FROM wm_tasks WHERE work_id=?1 AND status IN ('pending','waiting') ORDER BY chain_id,step_index,stack_position LIMIT 2";
pub(super) const RECOVERY_9: &str = "INSERT INTO wm_legacy_map(source,source_id,new_id,source_hash,imported_revision,batch) VALUES('result_recovery',?1,'','',0,'processed') ON CONFLICT(source,source_id) DO NOTHING";

#[cfg(feature = "test-support")]
pub(crate) const ALL: &[(&str, &str)] = &[
    ("LEGACY_RECOVERY_1", RECOVERY_1),
    ("LEGACY_RECOVERY_2", RECOVERY_2),
    ("LEGACY_RECOVERY_3", RECOVERY_3),
    ("LEGACY_RECOVERY_4", RECOVERY_4),
    ("LEGACY_RECOVERY_5", RECOVERY_5),
    ("LEGACY_RECOVERY_6", RECOVERY_6),
    ("LEGACY_RECOVERY_7", RECOVERY_7),
    ("LEGACY_RECOVERY_8", RECOVERY_8),
    ("LEGACY_RECOVERY_9", RECOVERY_9),
];
