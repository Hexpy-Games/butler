import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

export interface AppCatalogSession {
  title: string;
}

export function readAppConversationSessionCatalog(
  dbPath: string | undefined,
  conversationSessionIds: string[],
): { sessions: Map<string, AppCatalogSession>; diagnostic: string | null } {
  const sessions = new Map<string, AppCatalogSession>();
  if (!dbPath || !existsSync(dbPath) || conversationSessionIds.length === 0) {
    return { sessions, diagnostic: null };
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    if (!hasAppCatalogContract(db)) {
      return { sessions, diagnostic: "app-catalog-compat unavailable: chats contract missing" };
    }
    const placeholders = conversationSessionIds.map(() => "?").join(", ");
    const rows = db.query<{
      conversation_session_id: string;
      title: string;
    }, string[]>(`
      SELECT conversation_session_id, title
      FROM chats
      WHERE conversation_session_id IN (${placeholders})
    `).all(...conversationSessionIds);
    for (const row of rows) {
      sessions.set(row.conversation_session_id, {
        title: row.title,
      });
    }
    return { sessions, diagnostic: null };
  } catch (error) {
    return {
      sessions,
      diagnostic: `app-catalog-compat unavailable: ${safeErrorMessage(error)}`,
    };
  } finally {
    db.close();
  }
}

function hasAppCatalogContract(db: Database): boolean {
  const table = db.query<{ name: string }, [string]>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get("chats");
  if (!table) return false;
  const columns = new Set(
    db.query<{ name: string }, []>("PRAGMA table_info(chats)").all().map((row) => row.name),
  );
  return ["conversation_session_id", "title"]
    .every((column) => columns.has(column));
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
}
