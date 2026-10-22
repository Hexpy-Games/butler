//! Reads are pinned by the cutover query-plan contract. The one-time import
//! traverses legacy history by indexed keyset batches, never OFFSET or polling.
pub(super) const HAS_MIGRATION: &str =
    "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type='table' AND name='wm_migration')";
pub const EPOCH: &str = "SELECT writer_epoch FROM wm_migration WHERE singleton=1";
pub(super) const STATUS: &str =
    "SELECT state,needs_source_json FROM wm_migration WHERE singleton=1";
pub(super) const WORK_BATCH: &str =
    "SELECT work_id FROM btcc_guided_works WHERE work_id>?1 ORDER BY work_id LIMIT ?2";
pub(super) const FEED: &str =
    "SELECT seq,session_id FROM agent_task_graph_changes WHERE seq>?1 ORDER BY seq LIMIT 500";
pub(super) const WATERMARK: &str = "SELECT coalesce(max(seq),0) FROM agent_task_graph_changes";
pub const CURSOR: &str = "SELECT cursor_json FROM wm_migration WHERE singleton=1";
pub(super) const MAPPING: &str = "SELECT new_id,source_hash,imported_revision FROM wm_legacy_map WHERE source=?1 AND source_id=?2";
pub(super) const WORK: &str = "SELECT * FROM btcc_guided_works WHERE work_id=?1";
pub(super) const PLAN: &str =
    "SELECT * FROM btcc_guided_work_plan_revisions WHERE work_id=?1 ORDER BY revision DESC LIMIT 1";
pub(super) const CHECKPOINT: &str = "SELECT * FROM btcc_guided_work_checkpoint_revisions WHERE work_id=?1 ORDER BY revision DESC LIMIT 1";
pub(super) const DIRECTIONS: &str = "SELECT d.instruction_id,d.source_message_id,d.instruction,d.revision,r.child_session_id,g.child_turn_id,g.delegation_id,r.parent_session_id FROM btcc_subsession_directions d INDEXED BY wm_pending_directions JOIN btcc_session_relations r ON r.relation_id=d.relation_id LEFT JOIN btcc_subsession_delegations g ON g.relation_id=d.relation_id WHERE d.status='pending' AND d.instruction_id>?1 AND NOT EXISTS(SELECT 1 FROM wm_legacy_map m WHERE m.source='direction' AND m.source_id=d.instruction_id) ORDER BY d.instruction_id LIMIT 1";
pub(super) const NEW_DIRECTIONS: &str = "SELECT EXISTS(SELECT 1 FROM btcc_subsession_directions d INDEXED BY wm_pending_directions WHERE d.status='pending' AND NOT EXISTS(SELECT 1 FROM wm_legacy_map m WHERE m.source='direction' AND m.source_id=d.instruction_id))";
pub(super) const DELEGATION: &str = "SELECT d.*,r.child_session_id,r.parent_session_id FROM btcc_subsession_delegations d JOIN btcc_session_relations r ON r.relation_id=d.relation_id WHERE d.root_work_id=?1";
pub(super) const HISTORY: [&str; 6] = [
    "SELECT * FROM btcc_guided_work_plan_revisions WHERE work_id=?1 ORDER BY revision",
    "SELECT * FROM btcc_guided_work_checkpoint_revisions WHERE work_id=?1 ORDER BY revision",
    "SELECT * FROM btcc_guided_work_review_revisions WHERE work_id=?1 ORDER BY revision",
    "SELECT * FROM btcc_guided_work_disposition_revisions WHERE work_id=?1 ORDER BY revision",
    "SELECT * FROM btcc_guided_work_results WHERE work_id=?1 ORDER BY sequence",
    "SELECT * FROM btcc_guided_turn_work_bindings WHERE work_id=?1 ORDER BY turn_id,revision",
];

pub(super) const SESSION_BATCH: &str = "SELECT work_id FROM btcc_guided_works INDEXED BY wm_legacy_session_work WHERE session_id=?1 AND work_id>?2 ORDER BY work_id LIMIT 1";

pub(super) const CLEAR_EDGES: &str = "DELETE FROM wm_task_edges WHERE work_id=?1";

pub(super) const RETIRE_TASKS: &str = "UPDATE wm_tasks SET status='cancelled',hold_reason=NULL,held_by_task_id=NULL,failure_reason=NULL,chain_id=NULL,step_index=NULL,stack_position=NULL WHERE work_id=?1";

pub(super) const INSERT_EDGE: &str =
    "INSERT INTO wm_task_edges(work_id,chain_id,pred,succ) VALUES(?1,?2,?3,?4)";

pub(super) const ENSURE_CHAIN: &str =
    "INSERT INTO wm_task_chains(id,work_id,created_at) VALUES(?1,?2,?3) ON CONFLICT(id) DO NOTHING";

pub(super) const INSERT_TASK: &str = "INSERT INTO wm_tasks(id,work_id,spec_ref,title,status,chain_id,step_index,stack_position,origin,historical,result_reported_at,created_at,updated_at,created_by) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'migration',?9,?10,?11,?11,?12)";

pub(super) const CLEAR_PART_EDGES: &str = "DELETE FROM wm_task_part_edges WHERE task_id=?1";

pub(super) const RETIRE_PARTS: &str =
    "UPDATE wm_task_parts SET status='cancelled' WHERE task_id=?1";

pub(super) const UPSERT_PART: &str = "INSERT INTO wm_task_parts(id,task_id,kind,title,status,part_rank) VALUES(?1,?2,'execute',?3,?4,?5) ON CONFLICT(id) DO UPDATE SET title=excluded.title,status=excluded.status,part_rank=excluded.part_rank";

pub(super) const INSERT_PART_EDGE: &str =
    "INSERT INTO wm_task_part_edges(task_id,pred,succ) VALUES(?1,?2,?3)";

pub(super) const MIGRATION_EVENT: &str = "INSERT INTO wm_outbox(topic,payload_json,created_at) VALUES('stream.reconcile_required',?1,?2)";

pub(super) const BIND_IMPORTED_SPEC: &str = "UPDATE wm_works SET spec_node_id=?2,revision=?3,task_graph_revision=task_graph_revision+1 WHERE id=?1";

pub(super) const MAP_WORK: &str = "INSERT INTO wm_legacy_map(source,source_id,new_id,source_hash,imported_revision,batch) VALUES('work',?1,?2,?3,?4,?5) ON CONFLICT(source,source_id) DO UPDATE SET new_id=excluded.new_id,source_hash=excluded.source_hash,imported_revision=excluded.imported_revision,batch=excluded.batch";

pub(super) const IMPORT_WORK_FIELDS: &str = "UPDATE wm_works SET title=?2,home_session_id=?3,run_state=?4,tier=?5,import_note=?6,updated_at=?7 WHERE id=?1";

pub(super) const SPEC_VERSION: &str =
    "SELECT revision,active_revision FROM wm_spec_nodes WHERE node_id=?1";

pub(super) const BEGIN: &str = "INSERT INTO wm_migration VALUES(1,?1,'{}','{}',0,0,'[]')";

pub(super) const POSTPONE: &str =
    "UPDATE wm_migration SET state='postponed_no_space' WHERE singleton=1 AND writer_epoch=0";

pub(super) const MARKER: &str =
    "SELECT writer_epoch,legacy_feed_watermark FROM wm_migration WHERE singleton=1";

pub(super) const IMPORTING: &str = "UPDATE wm_migration SET state='importing' WHERE singleton=1";

pub(super) const SAVE_CURSOR: &str = "UPDATE wm_migration SET cursor_json=?1 WHERE singleton=1";

pub(super) const COUNT_WORK: &str = "UPDATE wm_migration SET source_counts_json=json_set(source_counts_json,'$.works',coalesce(json_extract(source_counts_json,'$.works'),0)+1) WHERE singleton=1";

pub(super) const INSTRUCTION: &str = "INSERT INTO wm_instructions(id,idempotency_key,target_session_id,sender,mode,body_ref,anchor_kind,anchor_id,boundary_seq,status,received_seq) VALUES(?1,?2,?3,?4,'queue',?5,'turn',?6,?7,?8,?7) ON CONFLICT(idempotency_key) DO NOTHING";

pub(super) const MAP_DIRECTION: &str = "INSERT INTO wm_legacy_map VALUES('direction',?1,?1,?2,0,?1) ON CONFLICT(source,source_id) DO NOTHING";

pub(super) const COUNT_DIRECTION: &str = "UPDATE wm_migration SET source_counts_json=json_set(source_counts_json,'$.directions',coalesce(json_extract(source_counts_json,'$.directions'),0)+1) WHERE singleton=1";

pub(super) const SWITCH: &str = "UPDATE wm_migration SET state='complete',writer_epoch=?1,legacy_feed_watermark=?2 WHERE singleton=1";

pub(super) const NEEDS_SOURCE: &str =
    "SELECT needs_source_json FROM wm_migration WHERE singleton=1";

pub(super) const SAVE_NEEDS_SOURCE: &str =
    "UPDATE wm_migration SET needs_source_json=?1 WHERE singleton=1";

pub(super) const TARGET_VERSION: &str =
    "SELECT source_hash FROM wm_legacy_map WHERE source='work_target' AND source_id=?1";
pub(super) const REMEMBER_TARGET: &str = "INSERT INTO wm_legacy_map VALUES('work_target',?1,?2,?3,0,?4) ON CONFLICT(source,source_id) DO UPDATE SET new_id=excluded.new_id,source_hash=excluded.source_hash,batch=excluded.batch";
pub(super) const TARGET_WORK_VERSION: &str = "SELECT w.revision,w.task_graph_revision,n.revision FROM wm_works w LEFT JOIN wm_spec_nodes n ON n.node_id=w.spec_node_id WHERE w.id=?1";
pub(super) const TARGET_TASK_VERSIONS: &str =
    "SELECT id,revision FROM wm_tasks WHERE work_id=?1 ORDER BY id";
pub(super) const ADMIT: &str = "INSERT INTO wm_instructions(id,idempotency_key,target_session_id,sender,mode,body_ref,anchor_kind,anchor_id,boundary_seq,status,received_seq) VALUES(?1,?2,?3,?4,'queue',?5,'turn',?6,?7,'waiting_for_turn',?7) ON CONFLICT(idempotency_key) DO NOTHING";
pub(super) const ADMISSION_RECEIPT: &str =
    "SELECT id,target_session_id,anchor_id,body_ref FROM wm_instructions WHERE idempotency_key=?1";

pub(super) const TASK_ASSIGNMENT: &str = "UPDATE wm_tasks SET assignee_session_id=?2 WHERE id=?1";

pub const APP_PROJECT_BATCH: &str = "SELECT id,ledger_project_id FROM projects WHERE id>?1 AND ledger_project_id IS NOT NULL ORDER BY id LIMIT 1";
pub const APP_SESSIONS: &str = "SELECT id,runtime_session_hint FROM chats INDEXED BY chats_project_artifacts_idx WHERE project_id=?1";

pub(super) const TASK_EXISTS: &str = "SELECT EXISTS(SELECT 1 FROM wm_tasks WHERE id=?1)";
pub(super) const UPDATE_TASK: &str = "UPDATE wm_tasks SET spec_ref=?3,title=?4,status=?5,chain_id=?6,step_index=?7,stack_position=?8,historical=?9,result_reported_at=?10,updated_at=?11,revision=revision+1 WHERE id=?1 AND work_id=?2";
pub(super) const CHAIN_STATE: &str = "UPDATE wm_task_chains SET state=?2 WHERE id=?1";

pub(super) const TASK_REVISION: &str = "SELECT revision FROM wm_tasks WHERE id=?1";
pub(super) const MAP_ENTITY: &str = "INSERT INTO wm_legacy_map VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(source,source_id) DO UPDATE SET new_id=excluded.new_id,source_hash=excluded.source_hash,imported_revision=excluded.imported_revision,batch=excluded.batch";

pub(super) const FAIL_BACKUP: &str =
    "UPDATE wm_migration SET state=?1 WHERE singleton=1 AND writer_epoch=0";

pub const BACKING_UP: &str =
    "UPDATE wm_migration SET state='backing_up' WHERE singleton=1 AND writer_epoch=0";

pub(super) const DELEGATION_BATCH: &str = "SELECT delegation_id,root_work_id FROM btcc_subsession_delegations WHERE delegation_id>?1 ORDER BY delegation_id LIMIT 1";
pub(super) const COUNT_DELEGATION: &str = "UPDATE wm_migration SET source_counts_json=json_set(source_counts_json,'$.delegations',coalesce(json_extract(source_counts_json,'$.delegations'),0)+1) WHERE singleton=1";

pub const ALL: &[(&str, &str)] = &[
    ("HAS_MIGRATION", HAS_MIGRATION),
    ("EPOCH", EPOCH),
    ("STATUS", STATUS),
    ("WORK_BATCH", WORK_BATCH),
    ("FEED", FEED),
    ("WATERMARK", WATERMARK),
    ("CURSOR", CURSOR),
    ("MAPPING", MAPPING),
    ("WORK", WORK),
    ("PLAN", PLAN),
    ("CHECKPOINT", CHECKPOINT),
    ("DIRECTIONS", DIRECTIONS),
    ("NEW_DIRECTIONS", NEW_DIRECTIONS),
    ("DELEGATION", DELEGATION),
    ("SESSION_BATCH", SESSION_BATCH),
    ("CLEAR_EDGES", CLEAR_EDGES),
    ("RETIRE_TASKS", RETIRE_TASKS),
    ("INSERT_EDGE", INSERT_EDGE),
    ("ENSURE_CHAIN", ENSURE_CHAIN),
    ("INSERT_TASK", INSERT_TASK),
    ("CLEAR_PART_EDGES", CLEAR_PART_EDGES),
    ("RETIRE_PARTS", RETIRE_PARTS),
    ("UPSERT_PART", UPSERT_PART),
    ("INSERT_PART_EDGE", INSERT_PART_EDGE),
    ("MIGRATION_EVENT", MIGRATION_EVENT),
    ("BIND_IMPORTED_SPEC", BIND_IMPORTED_SPEC),
    ("MAP_WORK", MAP_WORK),
    ("IMPORT_WORK_FIELDS", IMPORT_WORK_FIELDS),
    ("SPEC_VERSION", SPEC_VERSION),
    ("BEGIN", BEGIN),
    ("POSTPONE", POSTPONE),
    ("MARKER", MARKER),
    ("IMPORTING", IMPORTING),
    ("SAVE_CURSOR", SAVE_CURSOR),
    ("COUNT_WORK", COUNT_WORK),
    ("INSTRUCTION", INSTRUCTION),
    ("MAP_DIRECTION", MAP_DIRECTION),
    ("COUNT_DIRECTION", COUNT_DIRECTION),
    ("SWITCH", SWITCH),
    ("NEEDS_SOURCE", NEEDS_SOURCE),
    ("SAVE_NEEDS_SOURCE", SAVE_NEEDS_SOURCE),
    ("TARGET_VERSION", TARGET_VERSION),
    ("REMEMBER_TARGET", REMEMBER_TARGET),
    ("TARGET_WORK_VERSION", TARGET_WORK_VERSION),
    ("TARGET_TASK_VERSIONS", TARGET_TASK_VERSIONS),
    ("ADMIT", ADMIT),
    ("ADMISSION_RECEIPT", ADMISSION_RECEIPT),
    ("TASK_ASSIGNMENT", TASK_ASSIGNMENT),
    ("APP_PROJECT_BATCH", APP_PROJECT_BATCH),
    ("APP_SESSIONS", APP_SESSIONS),
    ("TASK_EXISTS", TASK_EXISTS),
    ("UPDATE_TASK", UPDATE_TASK),
    ("CHAIN_STATE", CHAIN_STATE),
    ("TASK_REVISION", TASK_REVISION),
    ("MAP_ENTITY", MAP_ENTITY),
    ("BACKING_UP", BACKING_UP),
    ("FAIL_BACKUP", FAIL_BACKUP),
    ("DELEGATION_BATCH", DELEGATION_BATCH),
    ("COUNT_DELEGATION", COUNT_DELEGATION),
    ("HISTORY_0", HISTORY[0]),
    ("HISTORY_1", HISTORY[1]),
    ("HISTORY_2", HISTORY[2]),
    ("HISTORY_3", HISTORY[3]),
    ("HISTORY_4", HISTORY[4]),
    ("HISTORY_5", HISTORY[5]),
];
