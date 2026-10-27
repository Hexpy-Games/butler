CREATE TABLE IF NOT EXISTS canon_proposals (
 id TEXT PRIMARY KEY NOT NULL,
 session_id TEXT NOT NULL,
 source_turn_id TEXT NOT NULL,
 source_call_id TEXT NOT NULL,
 project_id TEXT,
 summary TEXT NOT NULL,
 changes_json TEXT NOT NULL CHECK(json_valid(changes_json)),
 state TEXT NOT NULL CHECK(state IN ('open','applied','cancelled','superseded','stale')),
 resolved_by TEXT CHECK(resolved_by IN ('card','chat')),
 created_at TEXT NOT NULL,
 resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS canon_proposals_open_session ON canon_proposals(session_id,created_at) WHERE state='open';
CREATE INDEX IF NOT EXISTS canon_proposals_open ON canon_proposals(created_at) WHERE state='open';
CREATE INDEX IF NOT EXISTS canon_proposals_turn ON canon_proposals(source_turn_id,created_at,id);
CREATE INDEX IF NOT EXISTS canon_spec_nodes_shared_project ON canon_spec_nodes(scope_ref,node_id) WHERE scope_kind='project' AND visibility='canon';
