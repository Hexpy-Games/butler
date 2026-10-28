CREATE TABLE IF NOT EXISTS canon_proposals (
 id TEXT PRIMARY KEY NOT NULL,
 session_id TEXT,
 source_turn_id TEXT,
 source_call_id TEXT,
 project_id TEXT,
 summary TEXT NOT NULL,
 changes_json TEXT NOT NULL CHECK(json_valid(changes_json)),
 state TEXT NOT NULL CHECK(state IN ('open','applied','cancelled','superseded','stale')),
 resolved_by TEXT CHECK(resolved_by IN ('card','chat','inspector')),
 created_at TEXT NOT NULL,
 resolved_at TEXT,
 source TEXT NOT NULL DEFAULT 'chat' CHECK(source IN('chat','mcp')),
 actor_json TEXT CHECK(actor_json IS NULL OR json_valid(actor_json)),
 CHECK(source='mcp' OR (session_id IS NOT NULL AND source_turn_id IS NOT NULL AND source_call_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS canon_proposals_open_session ON canon_proposals(session_id,created_at) WHERE state='open';
CREATE INDEX IF NOT EXISTS canon_proposals_open ON canon_proposals(created_at) WHERE state='open';
CREATE INDEX IF NOT EXISTS canon_proposals_turn ON canon_proposals(source_turn_id,created_at,id);
CREATE INDEX IF NOT EXISTS canon_spec_nodes_shared_project ON canon_spec_nodes(scope_ref,node_id) WHERE scope_kind='project' AND visibility='canon';
