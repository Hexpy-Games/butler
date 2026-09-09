import type { Database } from "bun:sqlite";
import { migrateSessionContextSchema } from "./session-context-schema.ts";
import { migrateSessionBranchSchema } from "./session-branch-schema.ts";

/** Catalog triggers keep every existing creation/deletion ingress on one placement path. */
export function migrateSpaceSchema(db: Database): void {
  db.transaction(() => {
    db.exec(`
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
      CREATE TABLE IF NOT EXISTS app_space_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO app_space_state VALUES(1,0);
      CREATE TRIGGER IF NOT EXISTS space_project_created AFTER INSERT ON projects BEGIN
        INSERT INTO app_space_nodes(node_key,project_id,parent_key,position)
        VALUES('p:'||NEW.id,NEW.id,NULL,(SELECT COALESCE(MAX(position),-1)+1 FROM app_space_nodes WHERE parent_key IS NULL));
      END;
      CREATE TRIGGER IF NOT EXISTS space_session_created AFTER INSERT ON chats WHEN NEW.id!='general' BEGIN
        INSERT INTO app_space_nodes(node_key,session_id,parent_key,position)
        VALUES('s:'||NEW.id,NEW.id,CASE WHEN NEW.project_id IS NULL THEN NULL ELSE 'p:'||NEW.project_id END,
          (SELECT COALESCE(MAX(position),-1)+1 FROM app_space_nodes WHERE parent_key IS
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
    `);
  })();
  migrateSessionContextSchema(db);
  migrateSessionBranchSchema(db);
}
