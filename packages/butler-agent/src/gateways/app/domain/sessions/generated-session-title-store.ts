import { Database } from "bun:sqlite";
import type { ChatRow } from "../../infrastructure/core/records.ts";
import {
  normalizeGeneratedSessionTitle,
  provisionalSessionTitleFromPrompt,
} from "../../infrastructure/transport/app-transport-metadata.ts";
import type { SessionActionResult } from "../../interface/protocol/app-protocol.ts";

export class AppGeneratedSessionTitleStore {
  constructor(
    private readonly input: {
      db: Database;
      defaultChatTitle: string;
      getChatRow: (chatId: string) => ChatRow | null;
      updateSession: (
        sessionId: string,
        input: { title?: string },
      ) => SessionActionResult;
    },
  ) {}

  handler(
    chatId: string,
    sourceText: string,
  ): ((title: string) => void) | undefined {
    if (!this.isEligible(chatId, sourceText)) return undefined;
    return (title: string) => {
      const normalized = normalizeGeneratedSessionTitle(title);
      if (!normalized) return;
      if (!this.isEligible(chatId, sourceText)) return;
      const current = this.input.getChatRow(chatId);
      if (!current || current.title === normalized) return;
      this.input.updateSession(chatId, { title: normalized });
    };
  }

  private isEligible(chatId: string, sourceText: string): boolean {
    const chat = this.input.getChatRow(chatId);
    if (!chat) return false;
    const counts = this.input.db
      .query<{ user_count: number; assistant_count: number }, [string]>(
        `
      SELECT
        COALESCE(SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END), 0) AS user_count,
        COALESCE(SUM(CASE WHEN role = 'assistant' THEN 1 ELSE 0 END), 0) AS assistant_count
      FROM messages
      WHERE chat_id = ?
    `,
      )
      .get(chatId);
    if (!counts || counts.user_count > 1 || counts.assistant_count > 0) {
      return false;
    }
    const currentTitle = chat.title.trim();
    const provisionalTitle = provisionalSessionTitleFromPrompt(
      sourceText,
      chat.kind,
    );
    const defaultTitle =
      chat.kind === "project" ? "New project chat" : "New chat";
    return (
      currentTitle === defaultTitle ||
      (chat.kind === "chat" && currentTitle === this.input.defaultChatTitle) ||
      currentTitle === provisionalTitle
    );
  }
}
