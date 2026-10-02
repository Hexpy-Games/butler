//! Compact storage; canonical aliases own dictionary lifetime.
pub(super) const TABLES: &str = r"
CREATE TABLE memory_alias_documents(id INTEGER PRIMARY KEY,node_id TEXT NOT NULL,source_id TEXT NOT NULL,surface_original TEXT NOT NULL,UNIQUE(node_id,source_id,surface_original),FOREIGN KEY(node_id,surface_original,source_id) REFERENCES memory_aliases(node_id,surface_original,source_id) ON DELETE CASCADE);
CREATE TABLE memory_alias_grams(gram TEXT NOT NULL,alias_id INTEGER NOT NULL REFERENCES memory_alias_documents(id) ON DELETE CASCADE,PRIMARY KEY(gram,alias_id)) WITHOUT ROWID;
CREATE INDEX memory_alias_grams_alias ON memory_alias_grams(alias_id);
CREATE TABLE IF NOT EXISTS memory_alias_index_dirty(node_id TEXT NOT NULL,source_id TEXT NOT NULL,surface_original TEXT NOT NULL,PRIMARY KEY(node_id,source_id,surface_original));
CREATE TRIGGER memory_alias_documents_update BEFORE UPDATE ON memory_aliases BEGIN
 DELETE FROM memory_alias_documents WHERE node_id=OLD.node_id AND source_id=OLD.source_id AND surface_original=OLD.surface_original; END;
";

pub(super) const FRESH: &str = r"
CREATE TRIGGER memory_alias_index_insert AFTER INSERT ON memory_aliases BEGIN
 INSERT OR IGNORE INTO memory_alias_index_dirty VALUES(NEW.node_id,NEW.source_id,NEW.surface_original); END;
CREATE TRIGGER memory_alias_index_update AFTER UPDATE ON memory_aliases BEGIN
 INSERT OR IGNORE INTO memory_alias_index_dirty VALUES(NEW.node_id,NEW.source_id,NEW.surface_original); END;
CREATE TRIGGER memory_alias_index_delete BEFORE DELETE ON memory_aliases BEGIN
 DELETE FROM memory_alias_index_dirty WHERE node_id=OLD.node_id AND source_id=OLD.source_id AND surface_original=OLD.surface_original; END;
CREATE VIEW memory_alias_postings AS SELECT p.gram,a.node_id,a.source_id,a.surface_original FROM memory_alias_grams p JOIN memory_alias_documents a ON a.id=p.alias_id;
INSERT INTO memory_state VALUES('alias_postings_v2','fresh');
";

pub(super) const INSTALL: &str = r#"
DROP TRIGGER IF EXISTS memory_alias_index_scope;
CREATE VIEW memory_alias_read_postings AS
 SELECT p.gram,a.node_id,a.source_id,a.surface_original FROM memory_alias_grams p JOIN memory_alias_documents a ON a.id=p.alias_id WHERE a.id<>COALESCE((SELECT CAST(value AS INTEGER) FROM memory_state WHERE key='alias_postings_v2_pending_id'),0)
 UNION ALL
 SELECT p.gram,p.node_id,p.source_id,p.surface_original FROM memory_alias_postings p WHERE NOT EXISTS(SELECT 1 FROM memory_alias_documents a WHERE a.node_id=p.node_id AND a.source_id=p.source_id AND a.surface_original=p.surface_original AND a.id<>COALESCE((SELECT CAST(value AS INTEGER) FROM memory_state WHERE key='alias_postings_v2_pending_id'),0));
INSERT INTO memory_state VALUES('alias_postings_v2','copy');
INSERT INTO memory_state VALUES('alias_postings_v2_cursor','["","",""]');
"#;

pub(super) const CUTOVER: &str = r"
DROP VIEW memory_alias_read_postings;
CREATE VIEW memory_alias_read_postings AS SELECT p.gram,a.node_id,a.source_id,a.surface_original FROM memory_alias_grams p JOIN memory_alias_documents a ON a.id=p.alias_id;
UPDATE memory_state SET value='complete' WHERE key='alias_postings_v2';
DELETE FROM memory_state WHERE key='alias_postings_v2_cursor';
";

pub(super) const RECLAIM: &str = r"
DROP TRIGGER memory_alias_index_insert;
DROP TRIGGER memory_alias_index_update;
DROP TRIGGER memory_alias_index_delete;
DROP TRIGGER IF EXISTS memory_alias_index_scope;

CREATE TRIGGER memory_alias_index_insert AFTER INSERT ON memory_aliases BEGIN
 INSERT OR IGNORE INTO memory_alias_index_dirty VALUES(NEW.node_id,NEW.source_id,NEW.surface_original); END;
CREATE TRIGGER memory_alias_index_update AFTER UPDATE ON memory_aliases BEGIN
 INSERT OR IGNORE INTO memory_alias_index_dirty VALUES(NEW.node_id,NEW.source_id,NEW.surface_original); END;
CREATE TRIGGER memory_alias_index_delete BEFORE DELETE ON memory_aliases BEGIN
 DELETE FROM memory_alias_index_dirty WHERE node_id=OLD.node_id AND source_id=OLD.source_id AND surface_original=OLD.surface_original; END;
UPDATE memory_state SET value='reclaim' WHERE key='alias_postings_v2';
";
