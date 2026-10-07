//! Derived read-model invalidations, outside the canonical BTCC receipt manifest.
//! Source writes coalesce changes; reads and idle periods never write.
pub(in crate::btcc::storage) const SCHEMA: &str = r"
CREATE INDEX IF NOT EXISTS idx_btcc_graph_checkpoint_plan
ON btcc_guided_work_checkpoint_revisions(work_id,plan_revision_id,revision DESC);
CREATE INDEX IF NOT EXISTS idx_btcc_graph_bindings_session
ON btcc_guided_turn_work_bindings(session_id,work_id) WHERE is_current=1;
CREATE INDEX IF NOT EXISTS idx_btcc_graph_bindings_work
ON btcc_guided_turn_work_bindings(work_id,session_id) WHERE is_current=1;
CREATE TABLE IF NOT EXISTS agent_task_graph_changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL UNIQUE
);
CREATE TRIGGER IF NOT EXISTS task_graph_binding_insert AFTER INSERT ON btcc_guided_turn_work_bindings WHEN NEW.is_current=1 BEGIN
    INSERT INTO agent_task_graph_changes(session_id) VALUES(NEW.session_id)
    ON CONFLICT(session_id) DO UPDATE SET seq=excluded.seq;
END;
CREATE TRIGGER IF NOT EXISTS task_graph_work_insert AFTER INSERT ON btcc_guided_works BEGIN
    INSERT INTO agent_task_graph_changes(session_id) VALUES(NEW.session_id)
    ON CONFLICT(session_id) DO UPDATE SET seq=excluded.seq;
END;
CREATE TRIGGER IF NOT EXISTS task_graph_work_update AFTER UPDATE ON btcc_guided_works BEGIN
    INSERT INTO agent_task_graph_changes(session_id) VALUES(NEW.session_id)
    ON CONFLICT(session_id) DO UPDATE SET seq=excluded.seq;
    INSERT INTO agent_task_graph_changes(session_id) SELECT session_id FROM btcc_guided_turn_work_bindings WHERE work_id=NEW.work_id AND is_current=1
    ON CONFLICT(session_id) DO UPDATE SET seq=excluded.seq;
END;
CREATE TRIGGER IF NOT EXISTS task_graph_plan_insert AFTER INSERT ON btcc_guided_work_plan_revisions BEGIN
    INSERT INTO agent_task_graph_changes(session_id) SELECT session_id FROM btcc_guided_works WHERE work_id=NEW.work_id
    ON CONFLICT(session_id) DO UPDATE SET seq=excluded.seq;
END;
CREATE TRIGGER IF NOT EXISTS task_graph_checkpoint_insert AFTER INSERT ON btcc_guided_work_checkpoint_revisions BEGIN
    INSERT INTO agent_task_graph_changes(session_id) SELECT session_id FROM btcc_guided_works WHERE work_id=NEW.work_id
    ON CONFLICT(session_id) DO UPDATE SET seq=excluded.seq;
    INSERT INTO agent_task_graph_changes(session_id) SELECT r.parent_session_id FROM btcc_subsession_delegations d JOIN btcc_session_relations r ON r.relation_id=d.relation_id WHERE d.root_work_id=NEW.work_id
    ON CONFLICT(session_id) DO UPDATE SET seq=excluded.seq;
END;
CREATE TRIGGER IF NOT EXISTS task_graph_delegation_insert AFTER INSERT ON btcc_subsession_delegations BEGIN
    INSERT INTO agent_task_graph_changes(session_id) SELECT parent_session_id FROM btcc_session_relations WHERE relation_id=NEW.relation_id
    ON CONFLICT(session_id) DO UPDATE SET seq=excluded.seq;
END;
CREATE TRIGGER IF NOT EXISTS task_graph_result_insert AFTER INSERT ON btcc_steward_results BEGIN
    INSERT INTO agent_task_graph_changes(session_id) SELECT parent_session_id FROM btcc_session_relations WHERE relation_id=NEW.relation_id
    ON CONFLICT(session_id) DO UPDATE SET seq=excluded.seq;
END;
CREATE TRIGGER IF NOT EXISTS task_graph_turn_insert AFTER INSERT ON btcc_turns BEGIN
    INSERT INTO agent_task_graph_changes(session_id) SELECT parent_session_id FROM btcc_session_relations WHERE child_session_id=NEW.session_id
    ON CONFLICT(session_id) DO UPDATE SET seq=excluded.seq;
END;
CREATE TRIGGER IF NOT EXISTS task_graph_turn_update AFTER UPDATE ON btcc_turns BEGIN
    INSERT INTO agent_task_graph_changes(session_id) SELECT parent_session_id FROM btcc_session_relations WHERE child_session_id=NEW.session_id
    ON CONFLICT(session_id) DO UPDATE SET seq=excluded.seq;
END;
";
