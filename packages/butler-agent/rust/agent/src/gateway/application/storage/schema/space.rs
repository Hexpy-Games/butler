use rusqlite::Connection;

use super::super::AppStorageError;

pub(super) fn migrate(connection: &mut Connection) -> Result<(), AppStorageError> {
    let transaction = connection.transaction().map_err(AppStorageError::sqlite)?;
    transaction
        .execute_batch(SPACE_SCHEMA)
        .map_err(AppStorageError::sqlite)?;
    transaction.commit().map_err(AppStorageError::sqlite)?;
    connection
        .execute_batch(SESSION_CONTEXT_AND_BRANCH_SCHEMA)
        .map_err(AppStorageError::sqlite)
}

const SPACE_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS app_space_groups (
 id TEXT PRIMARY KEY, title TEXT NOT NULL,
 scope_project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
 origin TEXT NOT NULL CHECK(origin IN ('manual','smart')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_space_nodes (
 node_key TEXT PRIMARY KEY,
 session_id TEXT UNIQUE REFERENCES chats(id) ON DELETE CASCADE,
 project_id TEXT UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
 group_id TEXT UNIQUE REFERENCES app_space_groups(id) ON DELETE CASCADE,
 parent_key TEXT REFERENCES app_space_nodes(node_key) ON DELETE SET NULL,
 position INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
 manual_placement INTEGER NOT NULL DEFAULT 0,
 CHECK((session_id IS NOT NULL)+(project_id IS NOT NULL)+(group_id IS NOT NULL)=1)
);
CREATE INDEX IF NOT EXISTS app_space_children ON app_space_nodes(parent_key,position,node_key);
CREATE TABLE IF NOT EXISTS app_space_topics (
 session_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
 topic TEXT NOT NULL, topic_normalized TEXT NOT NULL, source_message_id TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS app_space_topic_lookup ON app_space_topics(topic_normalized);
CREATE TABLE IF NOT EXISTS app_space_state (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL
);
INSERT OR IGNORE INTO app_space_state VALUES(1,0);
DROP TRIGGER IF EXISTS space_project_created;
CREATE TRIGGER space_project_created AFTER INSERT ON projects BEGIN
 INSERT INTO app_space_nodes(node_key,project_id,parent_key,position)
 VALUES('p:'||NEW.id,NEW.id,NULL,
   (SELECT COALESCE(MIN(position),1)-1 FROM app_space_nodes WHERE parent_key IS NULL));
END;
DROP TRIGGER IF EXISTS space_session_created;
CREATE TRIGGER space_session_created AFTER INSERT ON chats WHEN NEW.id!='general' BEGIN
 INSERT INTO app_space_nodes(node_key,session_id,parent_key,position)
 VALUES('s:'||NEW.id,NEW.id,
   CASE WHEN NEW.project_id IS NULL THEN NULL ELSE 'p:'||NEW.project_id END,
   (SELECT COALESCE(MIN(position),1)-1 FROM app_space_nodes WHERE parent_key IS
     CASE WHEN NEW.project_id IS NULL THEN NULL ELSE 'p:'||NEW.project_id END));
END;
CREATE TRIGGER IF NOT EXISTS space_node_inserted AFTER INSERT ON app_space_nodes BEGIN
 UPDATE app_space_state SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS space_node_updated AFTER UPDATE ON app_space_nodes BEGIN
 UPDATE app_space_state SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS space_node_deleted AFTER DELETE ON app_space_nodes BEGIN
 UPDATE app_space_state SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS space_group_updated AFTER UPDATE ON app_space_groups BEGIN
 UPDATE app_space_state SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS space_chat_metadata AFTER UPDATE OF pinned,archived ON chats BEGIN
 UPDATE app_space_state SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS space_project_metadata AFTER UPDATE OF pinned,archived ON projects BEGIN
 UPDATE app_space_state SET revision=revision+1;
END;
INSERT OR IGNORE INTO app_space_nodes(node_key,project_id,parent_key,position)
 SELECT 'p:'||id,id,NULL,ROW_NUMBER() OVER(ORDER BY pinned DESC,updated_at DESC,id)-1 FROM projects;
INSERT OR IGNORE INTO app_space_nodes(node_key,session_id,parent_key,position)
 SELECT 's:'||id,id,CASE WHEN project_id IS NULL THEN NULL ELSE 'p:'||project_id END,
 (SELECT COUNT(*) FROM app_space_nodes n WHERE n.parent_key IS NULL)+
 ROW_NUMBER() OVER(PARTITION BY project_id ORDER BY pinned DESC,updated_at DESC,id)-1
 FROM chats WHERE id!='general';
"#;

const SESSION_CONTEXT_AND_BRANCH_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS app_session_context_gate (
 session_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
 owner_kind TEXT NOT NULL CHECK(owner_kind IN ('turn','relocate')), owner_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_session_relocations (
 operation_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
 phase TEXT NOT NULL CHECK(phase IN ('preparing','prepared','bound','committed','aborted')),
 from_json TEXT NOT NULL, to_json TEXT NOT NULL, prepared_json TEXT, error_code TEXT
);
INSERT OR IGNORE INTO app_session_context_gate(session_id,owner_kind,owner_id)
 SELECT chat_id,'turn',id FROM turns t
 WHERE (state NOT IN ('delivered','cancelled','failed','runtime_fault') OR retryable=1)
 AND rowid=(SELECT MAX(rowid) FROM turns WHERE chat_id=t.chat_id);
CREATE UNIQUE INDEX IF NOT EXISTS app_session_relocation_active
 ON app_session_relocations(session_id) WHERE phase IN ('preparing','prepared','bound');
CREATE TRIGGER IF NOT EXISTS session_context_queue_guard BEFORE INSERT ON session_queued_messages
 WHEN EXISTS(SELECT 1 FROM app_session_context_gate WHERE session_id=NEW.chat_id AND owner_kind='relocate')
 BEGIN SELECT RAISE(ABORT,'session_relocating'); END;
CREATE TRIGGER IF NOT EXISTS session_context_turn_guard BEFORE INSERT ON turns
 WHEN EXISTS(SELECT 1 FROM app_session_context_gate WHERE session_id=NEW.chat_id AND owner_kind='relocate')
 BEGIN SELECT RAISE(ABORT,'session_relocating'); END;
CREATE TRIGGER IF NOT EXISTS session_context_retry_guard BEFORE UPDATE OF state ON turns
 WHEN NEW.state NOT IN ('delivered','cancelled','failed','runtime_fault') AND
 EXISTS(SELECT 1 FROM app_session_context_gate WHERE session_id=NEW.chat_id AND owner_kind='relocate')
 BEGIN SELECT RAISE(ABORT,'session_relocating'); END;
CREATE TRIGGER IF NOT EXISTS session_context_node_delete_guard BEFORE DELETE ON app_space_nodes
 WHEN EXISTS(SELECT 1 FROM app_session_relocations WHERE phase IN ('preparing','prepared','bound') AND
 (OLD.node_key='s:'||session_id OR OLD.node_key=json_extract(to_json,'$.parentKey') OR
 OLD.node_key=json_extract(to_json,'$.targetKey') OR OLD.node_key=json_extract(from_json,'$.parentKey')))
 BEGIN SELECT RAISE(ABORT,'session_relocating'); END;
CREATE TRIGGER IF NOT EXISTS session_context_node_move_guard BEFORE UPDATE OF parent_key ON app_space_nodes
 WHEN OLD.parent_key IS NOT NEW.parent_key AND EXISTS(SELECT 1 FROM app_session_relocations
 WHERE phase IN ('preparing','prepared','bound') AND (OLD.node_key='s:'||session_id OR
 OLD.node_key=json_extract(to_json,'$.parentKey') OR OLD.node_key=json_extract(to_json,'$.targetKey')))
 BEGIN SELECT RAISE(ABORT,'session_relocating'); END;
CREATE TRIGGER IF NOT EXISTS session_context_project_delete_guard BEFORE DELETE ON projects
 WHEN EXISTS(SELECT 1 FROM app_session_relocations WHERE phase IN ('preparing','prepared','bound') AND
 (OLD.id=json_extract(to_json,'$.project.id') OR OLD.id=json_extract(from_json,'$.projectId')))
 BEGIN SELECT RAISE(ABORT,'session_relocating'); END;
CREATE TRIGGER IF NOT EXISTS session_context_project_update_guard BEFORE UPDATE OF workspace_path,archived ON projects
 WHEN EXISTS(SELECT 1 FROM app_session_relocations WHERE phase IN ('preparing','prepared','bound') AND
 (OLD.id=json_extract(to_json,'$.project.id') OR OLD.id=json_extract(from_json,'$.projectId')))
 BEGIN SELECT RAISE(ABORT,'session_relocating'); END;
CREATE TABLE IF NOT EXISTS app_session_branches (
 request_id TEXT PRIMARY KEY, input_digest TEXT NOT NULL,
 target_session_id TEXT NOT NULL UNIQUE REFERENCES chats(id) ON DELETE CASCADE,
 source_json TEXT NOT NULL, seed_json TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('prepared','ready'))
);
CREATE TRIGGER IF NOT EXISTS branch_pending_queue_guard BEFORE INSERT ON session_queued_messages
 WHEN EXISTS(SELECT 1 FROM app_session_branches WHERE target_session_id=NEW.chat_id AND state='prepared')
 BEGIN SELECT RAISE(ABORT,'session_branch_preparing'); END;
CREATE TRIGGER IF NOT EXISTS branch_pending_turn_guard BEFORE INSERT ON turns
 WHEN EXISTS(SELECT 1 FROM app_session_branches WHERE target_session_id=NEW.chat_id AND state='prepared')
 BEGIN SELECT RAISE(ABORT,'session_branch_preparing'); END;
"#;

#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    use super::SPACE_SCHEMA;

    #[test]
    fn existing_project_insert_trigger_is_replaced_with_prepend_order() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE projects(id TEXT PRIMARY KEY,pinned INTEGER,archived INTEGER,updated_at TEXT);
             CREATE TABLE chats(id TEXT PRIMARY KEY,project_id TEXT,pinned INTEGER,archived INTEGER,updated_at TEXT);",
        )
        .unwrap();
        db.execute_batch(SPACE_SCHEMA).unwrap();
        db.execute("INSERT INTO projects(id) VALUES('first')", [])
            .unwrap();
        db.execute_batch(
            "DROP TRIGGER space_project_created;
             CREATE TRIGGER space_project_created AFTER INSERT ON projects BEGIN
               INSERT INTO app_space_nodes(node_key,project_id,parent_key,position)
               VALUES('p:'||NEW.id,NEW.id,NULL,
                 (SELECT COALESCE(MAX(position),-1)+1 FROM app_space_nodes WHERE parent_key IS NULL));
             END;",
        )
        .unwrap();
        db.execute_batch(SPACE_SCHEMA).unwrap();
        db.execute("INSERT INTO projects(id) VALUES('second')", [])
            .unwrap();
        let front: String = db
            .query_row(
                "SELECT project_id FROM app_space_nodes WHERE parent_key IS NULL ORDER BY position LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(front, "second");
    }
}
