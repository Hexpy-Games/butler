CREATE TABLE memory_alias_postings(gram TEXT NOT NULL,node_id TEXT NOT NULL REFERENCES memory_nodes(id),source_id TEXT NOT NULL REFERENCES memory_chunk_sources(source_id),surface_original TEXT NOT NULL,identity_scope TEXT NOT NULL,project_id TEXT,PRIMARY KEY(gram,node_id,source_id,surface_original));
CREATE INDEX IF NOT EXISTS idx_alias_postings_gram_source ON memory_alias_postings(gram,node_id,source_id);
         CREATE INDEX IF NOT EXISTS idx_alias_postings_entity ON memory_alias_postings(node_id,gram,source_id,surface_original);
         CREATE INDEX IF NOT EXISTS idx_alias_postings_alias ON memory_alias_postings(node_id,source_id,surface_original,gram);
         CREATE INDEX IF NOT EXISTS idx_alias_postings_scope_gram_node ON memory_alias_postings(identity_scope,project_id,gram,node_id);
         CREATE TABLE IF NOT EXISTS memory_alias_index_dirty(node_id TEXT NOT NULL,source_id TEXT NOT NULL,surface_original TEXT NOT NULL,PRIMARY KEY(node_id,source_id,surface_original));
         CREATE TRIGGER IF NOT EXISTS memory_alias_index_insert AFTER INSERT ON memory_aliases BEGIN
           INSERT OR IGNORE INTO memory_alias_index_dirty VALUES(NEW.node_id,NEW.source_id,NEW.surface_original); END;
         CREATE TRIGGER IF NOT EXISTS memory_alias_index_update AFTER UPDATE ON memory_aliases BEGIN
           DELETE FROM memory_alias_postings WHERE node_id=OLD.node_id AND source_id=OLD.source_id AND surface_original=OLD.surface_original;
           INSERT OR IGNORE INTO memory_alias_index_dirty VALUES(NEW.node_id,NEW.source_id,NEW.surface_original); END;
         CREATE TRIGGER IF NOT EXISTS memory_alias_index_delete BEFORE DELETE ON memory_aliases BEGIN
           DELETE FROM memory_alias_postings WHERE node_id=OLD.node_id AND source_id=OLD.source_id AND surface_original=OLD.surface_original;
           DELETE FROM memory_alias_index_dirty WHERE node_id=OLD.node_id AND source_id=OLD.source_id AND surface_original=OLD.surface_original; END;
         CREATE TRIGGER IF NOT EXISTS memory_alias_index_scope AFTER UPDATE OF identity_scope,project_id ON memory_nodes
           WHEN NEW.identity_scope IS NOT OLD.identity_scope OR NEW.project_id IS NOT OLD.project_id BEGIN
           INSERT OR IGNORE INTO memory_alias_index_dirty SELECT node_id,source_id,surface_original FROM memory_aliases WHERE node_id=NEW.id; END;
CREATE TABLE IF NOT EXISTS memory_claims(node_id TEXT PRIMARY KEY REFERENCES memory_nodes(id),statement TEXT NOT NULL,speech_act TEXT NOT NULL,basis TEXT NOT NULL,polarity TEXT NOT NULL,condition TEXT,requirement TEXT,valid_from TEXT,valid_to TEXT,salience TEXT NOT NULL,source_class TEXT NOT NULL CHECK(source_class IN ('user','assistant','task_report','explicit','mixed','unknown')),authority TEXT NOT NULL DEFAULT 'model_interpretation' CHECK(authority='model_interpretation'));
