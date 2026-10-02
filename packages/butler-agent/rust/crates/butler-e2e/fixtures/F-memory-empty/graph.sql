-- Empty graph fixture pinned from the v3 graph schema.
BEGIN TRANSACTION;
CREATE TABLE edge_evidence(edge_id TEXT NOT NULL REFERENCES edges(edge_id),chunk_source_id TEXT NOT NULL REFERENCES memory_chunk_sources(source_id),basis TEXT NOT NULL,extraction_version TEXT NOT NULL,PRIMARY KEY(edge_id,chunk_source_id));
CREATE TABLE edges(edge_id TEXT PRIMARY KEY,source_node_id TEXT NOT NULL REFERENCES memory_nodes(id),target_node_id TEXT NOT NULL REFERENCES memory_nodes(id),rel_type TEXT NOT NULL,claim_node_id TEXT REFERENCES memory_nodes(id),qualifiers TEXT NOT NULL DEFAULT '{}',valid_from TEXT,valid_to TEXT,status TEXT NOT NULL DEFAULT 'active',UNIQUE(source_node_id,target_node_id,rel_type,claim_node_id,qualifiers));
CREATE TABLE memory_aliases(node_id TEXT NOT NULL REFERENCES memory_nodes(id),surface_original TEXT NOT NULL,nfc_key TEXT NOT NULL,folded_key TEXT NOT NULL,language_tags TEXT NOT NULL DEFAULT '[]',source_id TEXT NOT NULL REFERENCES memory_chunk_sources(source_id),resolution_kind TEXT NOT NULL,PRIMARY KEY(node_id,surface_original,source_id));
CREATE TABLE memory_chunk_graph_refs(memory_chunk_id TEXT NOT NULL REFERENCES memory_chunks(memory_chunk_id),graph_ref_type TEXT NOT NULL,graph_ref_id TEXT NOT NULL,relation TEXT NOT NULL,PRIMARY KEY(memory_chunk_id,graph_ref_type,graph_ref_id,relation));
CREATE TABLE memory_chunk_sources(source_id TEXT PRIMARY KEY,episode_id TEXT NOT NULL REFERENCES memory_chunks(memory_chunk_id),revision TEXT NOT NULL,source_kind TEXT NOT NULL,conversation_session_id TEXT,conversation_message_id TEXT,part_id TEXT NOT NULL,scalar_pointer TEXT NOT NULL,byte_start INTEGER NOT NULL,byte_end INTEGER NOT NULL,content_hash TEXT NOT NULL,role TEXT NOT NULL,origin_kind TEXT NOT NULL,observed_at TEXT NOT NULL,basis TEXT NOT NULL,UNIQUE(episode_id,revision,conversation_message_id,part_id,scalar_pointer,byte_start,byte_end));
CREATE TABLE memory_chunks(memory_chunk_id TEXT PRIMARY KEY,source_key TEXT NOT NULL UNIQUE,current_revision TEXT NOT NULL,conversation_session_id TEXT,conversation_turn_id TEXT,conversation_start TEXT,conversation_end TEXT,project_id TEXT,origin_kind TEXT NOT NULL,status TEXT NOT NULL,summary TEXT NOT NULL DEFAULT '',summary_status TEXT NOT NULL DEFAULT 'pending',source_hash TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE memory_evidence(node_id TEXT NOT NULL REFERENCES memory_nodes(id),source_id TEXT NOT NULL REFERENCES memory_chunk_sources(source_id),episode_id TEXT NOT NULL,revision TEXT NOT NULL,PRIMARY KEY(node_id,source_id));
CREATE TABLE memory_hot_cache_outcomes(entry_id TEXT PRIMARY KEY,generation TEXT NOT NULL,admitted INTEGER NOT NULL,reason TEXT,receipt_json TEXT NOT NULL);
CREATE TABLE memory_nodes(id TEXT PRIMARY KEY,type TEXT NOT NULL,label_original TEXT NOT NULL,identity_scope TEXT NOT NULL,project_id TEXT,canonical_node_id TEXT REFERENCES memory_nodes(id),created_at TEXT NOT NULL, window_ref TEXT REFERENCES memory_projection_windows(window_ref), identity_history_job_id TEXT REFERENCES memory_projection_jobs(job_id), identity_history_ref TEXT);
CREATE TABLE memory_projection_attempts(attempt_ref TEXT PRIMARY KEY,window_ref TEXT NOT NULL,job_id TEXT NOT NULL,attempt_count INTEGER NOT NULL,state TEXT NOT NULL,error_code TEXT,input_sha256 TEXT,output_json TEXT,provider_evidence_json TEXT,recorded_at TEXT NOT NULL,attempt_kind TEXT NOT NULL DEFAULT 'provider',provider_invoked INTEGER NOT NULL DEFAULT 0,outcome_known INTEGER NOT NULL DEFAULT 1,invocation_ref TEXT, recovery_revision TEXT, recovery_request_json TEXT,UNIQUE(window_ref,attempt_count,state));
CREATE TABLE memory_projection_jobs(job_id TEXT PRIMARY KEY,episode_id TEXT NOT NULL,revision TEXT NOT NULL,extraction_version TEXT NOT NULL,generation TEXT NOT NULL,extraction_model TEXT NOT NULL,reasoning_effort TEXT NOT NULL,observed_completion_job_ids TEXT NOT NULL,source_state TEXT NOT NULL,semantic_graph_state TEXT NOT NULL,episode_vectors_state TEXT NOT NULL,node_vectors_state TEXT NOT NULL,hot_cache_state TEXT NOT NULL,next_stage TEXT NOT NULL DEFAULT 'semantic_graph',last_served_at TEXT,created_at TEXT NOT NULL, hot_cache_receipt_json TEXT, identity_decisions_json TEXT NOT NULL DEFAULT '[]', hot_cache_attempt_count INTEGER NOT NULL DEFAULT 0, hot_cache_next_attempt_at TEXT, hot_cache_owner_pid INTEGER, hot_cache_owner_nonce TEXT, hot_cache_started_at TEXT,UNIQUE(episode_id,revision,extraction_version));
CREATE TABLE memory_projection_model_policy(id INTEGER PRIMARY KEY CHECK(id=1),primary_model TEXT NOT NULL,primary_effort TEXT NOT NULL,fallback_model TEXT NOT NULL,fallback_effort TEXT NOT NULL,active_slot TEXT NOT NULL CHECK(active_slot IN ('primary','fallback')),updated_at TEXT NOT NULL,last_transition_json TEXT);
CREATE TABLE memory_projection_windows(window_ref TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES memory_projection_jobs(job_id),ordinal INTEGER NOT NULL,source_refs_json TEXT NOT NULL,output_json TEXT,normalized_plan_json TEXT,provider_evidence_json TEXT,state TEXT NOT NULL,error_code TEXT,attempt_count INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT,owner_pid INTEGER,owner_nonce TEXT,started_at TEXT,input_json TEXT,input_sha256 TEXT,input_migration_note TEXT,parent_window_ref TEXT,replaced_by_json TEXT, extraction_stages_json TEXT NOT NULL DEFAULT '{}', recovery_revision TEXT, recovery_base_attempt_count INTEGER NOT NULL DEFAULT 0,UNIQUE(job_id,ordinal));
CREATE TABLE memory_source_split_parents(source_id TEXT PRIMARY KEY,episode_id TEXT NOT NULL,revision TEXT NOT NULL,source_kind TEXT NOT NULL,conversation_session_id TEXT,conversation_message_id TEXT,part_id TEXT NOT NULL,scalar_pointer TEXT NOT NULL,byte_start INTEGER NOT NULL,byte_end INTEGER NOT NULL,content_hash TEXT NOT NULL,role TEXT NOT NULL,origin_kind TEXT NOT NULL,observed_at TEXT NOT NULL,basis TEXT NOT NULL,child_source_ids_json TEXT NOT NULL,recorded_at TEXT NOT NULL);
CREATE TABLE memory_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
INSERT INTO "memory_state" VALUES('graph_revision','0');
INSERT INTO "memory_state" VALUES('source_graph_schema','3');
CREATE TABLE memory_vector_units(unit_id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES memory_projection_jobs(job_id),record_kind TEXT NOT NULL,owner_id TEXT NOT NULL,owner_revision TEXT NOT NULL,project_id TEXT,origin_kind TEXT NOT NULL,projection_text TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',error_code TEXT,attempt_count INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT,owner_pid INTEGER,owner_nonce TEXT,started_at TEXT,receipt_json TEXT,source_ids_json TEXT,source_byte_start INTEGER,source_byte_end INTEGER,source_role TEXT, provider_invoked INTEGER NOT NULL DEFAULT 0, outcome_known INTEGER NOT NULL DEFAULT 1, invocation_ref TEXT,UNIQUE(job_id,record_kind,owner_id,owner_revision,project_id,origin_kind));
CREATE VIEW memory_source_leaves AS SELECT s.* FROM memory_chunk_sources s WHERE NOT EXISTS(SELECT 1 FROM memory_source_split_parents p WHERE p.source_id=s.source_id);
CREATE INDEX idx_alias_nfc ON memory_aliases(nfc_key,node_id);
CREATE INDEX idx_alias_folded ON memory_aliases(folded_key,node_id);
CREATE INDEX memory_evidence_episode ON memory_evidence(episode_id,node_id,source_id);
CREATE INDEX memory_evidence_source ON memory_evidence(source_id,node_id);
CREATE INDEX memory_edges_claim ON edges(claim_node_id,status,rel_type);
CREATE INDEX idx_edges_source_rel ON edges(source_node_id,rel_type);
CREATE INDEX idx_edges_target_rel ON edges(target_node_id,rel_type);
CREATE INDEX idx_mentions_entity_episode ON memory_evidence(node_id,episode_id);
CREATE INDEX idx_sources_message_revision ON memory_chunk_sources(conversation_message_id,revision);
CREATE INDEX idx_chunks_project_origin ON memory_chunks(project_id,origin_kind,conversation_start,memory_chunk_id);
CREATE INDEX idx_jobs_state ON memory_projection_jobs(last_served_at,created_at,job_id);
CREATE INDEX idx_vector_units_state ON memory_vector_units(state,job_id,record_kind,unit_id);
COMMIT;



CREATE TABLE memory_alias_documents(id INTEGER PRIMARY KEY,node_id TEXT NOT NULL,source_id TEXT NOT NULL,surface_original TEXT NOT NULL,UNIQUE(node_id,source_id,surface_original),FOREIGN KEY(node_id,surface_original,source_id) REFERENCES memory_aliases(node_id,surface_original,source_id) ON DELETE CASCADE);
CREATE TABLE memory_alias_grams(gram TEXT NOT NULL,alias_id INTEGER NOT NULL REFERENCES memory_alias_documents(id) ON DELETE CASCADE,PRIMARY KEY(gram,alias_id)) WITHOUT ROWID;
CREATE INDEX memory_alias_grams_alias ON memory_alias_grams(alias_id);
CREATE TABLE IF NOT EXISTS memory_alias_index_dirty(node_id TEXT NOT NULL,source_id TEXT NOT NULL,surface_original TEXT NOT NULL,PRIMARY KEY(node_id,source_id,surface_original));
CREATE TRIGGER memory_alias_documents_update BEFORE UPDATE ON memory_aliases BEGIN
 DELETE FROM memory_alias_documents WHERE node_id=OLD.node_id AND source_id=OLD.source_id AND surface_original=OLD.surface_original; END;

CREATE TRIGGER memory_alias_index_insert AFTER INSERT ON memory_aliases BEGIN
 INSERT OR IGNORE INTO memory_alias_index_dirty VALUES(NEW.node_id,NEW.source_id,NEW.surface_original); END;
CREATE TRIGGER memory_alias_index_update AFTER UPDATE ON memory_aliases BEGIN
 INSERT OR IGNORE INTO memory_alias_index_dirty VALUES(NEW.node_id,NEW.source_id,NEW.surface_original); END;
CREATE TRIGGER memory_alias_index_delete BEFORE DELETE ON memory_aliases BEGIN
 DELETE FROM memory_alias_index_dirty WHERE node_id=OLD.node_id AND source_id=OLD.source_id AND surface_original=OLD.surface_original; END;
CREATE VIEW memory_alias_postings AS SELECT p.gram,a.node_id,a.source_id,a.surface_original FROM memory_alias_grams p JOIN memory_alias_documents a ON a.id=p.alias_id;
INSERT INTO memory_state VALUES('alias_postings_v2','fresh');
