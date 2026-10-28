CREATE TABLE IF NOT EXISTS canon_mcp_grants (
 id TEXT PRIMARY KEY, client_name TEXT NOT NULL, client_title TEXT NOT NULL,
 person TEXT NOT NULL, requested_json TEXT NOT NULL CHECK(json_valid(requested_json)),
 allowed_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(allowed_json)),
 state TEXT NOT NULL CHECK(state IN('pending','allowed','denied','revoked')),
 requested_at INTEGER NOT NULL, decided_at INTEGER, UNIQUE(client_name,person)
);
CREATE INDEX IF NOT EXISTS canon_mcp_grants_recent ON canon_mcp_grants(requested_at DESC,id);
CREATE INDEX IF NOT EXISTS canon_mcp_grants_state ON canon_mcp_grants(state,requested_at DESC,id);
CREATE TABLE IF NOT EXISTS canon_activity (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, entity_id TEXT NOT NULL,
 actor_json TEXT NOT NULL CHECK(json_valid(actor_json)),
 kind TEXT NOT NULL CHECK(kind IN('comment','status','created','proposal_opened','proposal_applied','proposal_declined')),
 summary TEXT NOT NULL, body TEXT, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS canon_activity_status ON canon_activity(entity_id,seq DESC) WHERE kind='status';
CREATE INDEX IF NOT EXISTS canon_activity_entity ON canon_activity(entity_id,seq DESC);
CREATE INDEX IF NOT EXISTS canon_proposals_mcp_project ON canon_proposals(project_id,created_at) WHERE source='mcp' AND state='open';
CREATE INDEX IF NOT EXISTS canon_epics_page ON canon_epics(project_id,id);
CREATE INDEX IF NOT EXISTS canon_plans_page ON canon_plans(project_id,id);
CREATE INDEX IF NOT EXISTS canon_proposals_mcp_spec ON canon_proposals(json_extract(changes_json,'$[0].id'),created_at) WHERE source='mcp' AND state='open';
CREATE INDEX IF NOT EXISTS canon_epics_plan_page ON canon_epics(plan_id,id);
CREATE INDEX IF NOT EXISTS canon_epics_active_page ON canon_epics(id) WHERE canon_status!='done';
CREATE INDEX IF NOT EXISTS canon_epics_project_active_page ON canon_epics(project_id,id) WHERE canon_status!='done';
CREATE INDEX IF NOT EXISTS canon_epics_plan_active_page ON canon_epics(plan_id,id) WHERE canon_status!='done';
CREATE INDEX IF NOT EXISTS canon_proposals_chat_open ON canon_proposals(created_at DESC,id DESC) WHERE source='chat' AND state='open';
