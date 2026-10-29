CREATE TABLE IF NOT EXISTS canon_activity (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, entity_id TEXT NOT NULL,
 actor_json TEXT NOT NULL CHECK(json_valid(actor_json)),
 kind TEXT NOT NULL CHECK(kind IN('comment','status','created','proposal_opened','proposal_applied','proposal_declined','criterion_confirmed','criterion_unconfirmed')),
 summary TEXT NOT NULL, body TEXT, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS canon_activity_status ON canon_activity(entity_id,seq DESC) WHERE kind='status';
CREATE INDEX IF NOT EXISTS canon_activity_entity ON canon_activity(entity_id,seq DESC);
