import { normalizeLimit } from "../store-internals.ts";
import type {
  ConversationBinding,
  ConversationSession,
  ConversationSessionOverview,
} from "../types.ts";
import type { ConversationStoreDependencies } from "./dependencies.ts";

export class ConversationSessionRecords {
  constructor(private readonly dependencies: ConversationStoreDependencies) {}

  getSessionByGatewayBinding(
    gateway: string,
    externalSessionId: string,
  ): ConversationSession | null {
    return this.dependencies.db.query<ConversationSession, [string, string]>(`
      SELECT s.*
      FROM conversation_sessions s
      JOIN conversation_bindings b ON b.conversation_session_id = s.id
      WHERE b.gateway = ? AND b.external_session_id = ?
      LIMIT 1
    `).get(gateway, externalSessionId) ?? null;
  }

  getSession(sessionId: string): ConversationSession | null {
    return this.dependencies.db.query<ConversationSession, [string]>(`
      SELECT *
      FROM conversation_sessions
      WHERE id = ?
      LIMIT 1
    `).get(sessionId) ?? null;
  }

  listSessions(input: {
    projectId?: string | null;
    includeArchived?: boolean;
    limit?: number;
  } = {}): ConversationSessionOverview[] {
    const limit = normalizeLimit(input.limit, 20, 101);
    const status = input.includeArchived
      ? "s.status != 'deleted'"
      : "s.status = 'active'";
    const projectId = input.projectId?.trim();
    const select = `
      SELECT s.*, COUNT(m.id) AS message_count
      FROM conversation_sessions s
      LEFT JOIN conversation_messages m ON m.session_id = s.id
    `;
    const groupAndOrder = `
      GROUP BY s.id
      ORDER BY s.updated_at DESC, s.created_at DESC, s.id DESC
      LIMIT ?
    `;
    if (projectId) {
      return this.dependencies.db
        .query<ConversationSessionOverview, [string, number]>(
          `${select} WHERE ${status} AND s.project_id = ? ${groupAndOrder}`,
        )
        .all(projectId, limit);
    }
    return this.dependencies.db
      .query<ConversationSessionOverview, [number]>(
        `${select} WHERE ${status} ${groupAndOrder}`,
      )
      .all(limit);
  }

  getGatewayBindingForConversation(
    sessionId: string,
    gateway: string,
  ): ConversationBinding | null {
    return this.dependencies.db.query<ConversationBinding, [string, string]>(`
      SELECT gateway, external_session_id, conversation_session_id, created_at
      FROM conversation_bindings
      WHERE conversation_session_id = ? AND gateway = ?
      LIMIT 1
    `).get(sessionId, gateway) ?? null;
  }
}
