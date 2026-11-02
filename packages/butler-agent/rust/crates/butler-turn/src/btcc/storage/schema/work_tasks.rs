//! Exclusive Task ownership and settlement share the existing writer transaction.
pub(in crate::btcc::storage) const SCHEMA: &str = r"
CREATE TABLE IF NOT EXISTS btcc_work_tasks (
 task_id TEXT PRIMARY KEY,
 work_id TEXT NOT NULL REFERENCES btcc_guided_works(work_id),
 plan_revision_id TEXT NOT NULL,
 action_key TEXT NOT NULL,
 relation_id TEXT NOT NULL UNIQUE REFERENCES btcc_session_relations(relation_id),
 status TEXT NOT NULL CHECK(status IN ('pending','active','done','superseded','cancelled')),
 scope_json TEXT NOT NULL,
 inputs_json TEXT NOT NULL,
 output_json TEXT NOT NULL,
 overlaps_json TEXT NOT NULL,
 merge_after TEXT NOT NULL,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS btcc_work_task_waits (
 task_id TEXT NOT NULL REFERENCES btcc_work_tasks(task_id),
 after_task_id TEXT NOT NULL REFERENCES btcc_work_tasks(task_id),
 PRIMARY KEY(task_id,after_task_id)
);
CREATE INDEX IF NOT EXISTS idx_btcc_work_task_waits_after ON btcc_work_task_waits(after_task_id,task_id);
CREATE TRIGGER IF NOT EXISTS work_task_owner_insert BEFORE INSERT ON btcc_work_tasks
WHEN (SELECT status FROM btcc_guided_works WHERE work_id=NEW.work_id) IN ('completed','abandoned') BEGIN
 SELECT RAISE(ABORT,'task_owner_terminal');
END;
CREATE INDEX IF NOT EXISTS idx_btcc_work_tasks_work ON btcc_work_tasks(work_id,status);
CREATE TRIGGER IF NOT EXISTS work_task_direction BEFORE INSERT ON btcc_subsession_directions
WHEN EXISTS (SELECT 1 FROM btcc_work_tasks t JOIN btcc_guided_works w ON w.work_id=t.work_id
 WHERE t.relation_id=NEW.relation_id AND (t.status='superseded' OR w.status IN ('completed','abandoned'))) BEGIN
 SELECT RAISE(ABORT,'task_owner_terminal');
END;
CREATE TRIGGER IF NOT EXISTS work_task_dispatch AFTER UPDATE OF dispatch_state ON btcc_subsession_delegations
WHEN NEW.dispatch_state='enqueued' BEGIN
 UPDATE btcc_work_tasks SET status='active',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE relation_id=NEW.relation_id AND status='pending';
END;
CREATE TRIGGER IF NOT EXISTS work_task_supersede AFTER UPDATE OF packet_json ON btcc_subsession_delegations
WHEN json_extract(NEW.packet_json,'$.superseded_by') IS NOT NULL BEGIN
 UPDATE btcc_work_tasks SET status='superseded',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE relation_id=NEW.relation_id AND status IN ('pending','active');
END;
CREATE TRIGGER IF NOT EXISTS work_task_result AFTER INSERT ON btcc_steward_results BEGIN
 UPDATE btcc_work_tasks SET status=CASE WHEN NEW.status='success' THEN 'done' ELSE 'cancelled' END,updated_at=NEW.created_at
 WHERE relation_id=NEW.relation_id AND status IN ('pending','active');
 UPDATE btcc_work_tasks SET status=CASE WHEN NEW.status='success' THEN 'done' ELSE 'cancelled' END,updated_at=NEW.created_at
 WHERE work_id IN (SELECT root_work_id FROM btcc_subsession_delegations WHERE relation_id=NEW.relation_id)
 AND status IN ('pending','active');
END;
CREATE TRIGGER IF NOT EXISTS work_task_owner_work AFTER UPDATE OF status ON btcc_guided_works
WHEN NEW.status IN ('completed','abandoned') BEGIN
 UPDATE btcc_work_tasks SET status=CASE WHEN NEW.status='completed' THEN 'done' ELSE 'cancelled' END,updated_at=NEW.updated_at
 WHERE work_id=NEW.work_id AND status IN ('pending','active');
END;
CREATE TRIGGER IF NOT EXISTS work_task_owner_stop AFTER UPDATE OF semantic_state ON btcc_turns
WHEN NEW.semantic_state='cancelled' BEGIN
 UPDATE btcc_work_tasks SET status='cancelled',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE work_id IN (SELECT work_id FROM btcc_guided_turn_work_bindings WHERE turn_id=NEW.turn_id AND is_current=1)
 AND status IN ('pending','active');
 UPDATE btcc_work_tasks SET status='cancelled',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE relation_id IN (SELECT relation_id FROM btcc_session_relations WHERE child_session_id=NEW.session_id)
 AND status IN ('pending','active');
END;
CREATE TRIGGER IF NOT EXISTS work_task_owner_delivery AFTER UPDATE OF semantic_state ON btcc_turns
WHEN NEW.semantic_state='delivered' BEGIN
 UPDATE btcc_work_tasks SET status='done',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE work_id IN (SELECT work_id FROM btcc_guided_turn_work_bindings WHERE turn_id=NEW.turn_id AND is_current=1)
 AND status IN ('pending','active');
END;
CREATE TRIGGER IF NOT EXISTS work_task_graph_update AFTER UPDATE ON btcc_work_tasks BEGIN
 INSERT INTO agent_task_graph_changes(session_id) SELECT session_id FROM btcc_guided_works WHERE work_id=NEW.work_id
 ON CONFLICT(session_id) DO UPDATE SET seq=excluded.seq;
END;
";
