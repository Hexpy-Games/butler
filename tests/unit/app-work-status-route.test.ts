import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conversationSessionIdForDurableSession } from
  "../../packages/butler-agent/src/agent/conversation/session-admission.ts";
import type { PrincipalAuthority } from
  "../../packages/butler-agent/src/agent/btcc/authority/index.ts";
import { createTestAppServer as createAppServer } from
  "../../packages/butler-agent/src/test-support/app-server.ts";
import { EMPTY_STEWARD_OBSERVER } from "./support/steward-observer.ts";

test("authenticated work status includes bounded canonical report and artifact labels", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-work-status-route-"));
  const dbPath = join(root, "app.sqlite");
  const sessionId = "session-work-status";
  const conversationSessionId = conversationSessionIdForDurableSession(sessionId);
  const server = createAppServer({
    dbPath,
    butlerData: root,
    port: 0,
    localAuth: { required: true, token: "work-status-token" },
    authority: {} as PrincipalAuthority,
    stewardObserver: {
      ...EMPTY_STEWARD_OBSERVER,
      workStatus: () => ({
        items: [{
          session_id: sessionId,
          safe_title: "Current work",
          safe_summary: "Reviewing the current result.",
          state: "running",
          completed_actions: 1,
          total_actions: 2,
          effect_count: 1,
          updated_at: "2026-09-04T00:00:00.000Z",
        }],
        counts: {
          running: 1,
          completed: 0,
          attention: 0,
          operational_action: 0,
          operational_interruption: 0,
        },
      }),
    },
  });
  const db = new Database(dbPath);
  try {
    seedConversationProjection(db, sessionId, conversationSessionId);
    const unauthenticated = await fetch(`${server.url}work-status`);
    expect(unauthenticated.status).toBe(401);
    const response = await fetch(`${server.url}work-status`, {
      headers: { authorization: "Bearer work-status-token" },
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.items[0]).toMatchObject({
      latest_report_summary:
        "Completed internal reference at local reference Reference reference is internal reference. Final outcome.",
      recent_artifacts: ["review-summary.pdf"],
    });
    expect(JSON.stringify(body)).not.toContain("/Users/private/project");
    expect(JSON.stringify(body)).not.toContain("conversation-message-private");
    expect(JSON.stringify(body)).not.toContain("file-private");
  } finally {
    db.close();
    server.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

function seedConversationProjection(
  db: Database,
  sessionId: string,
  conversationSessionId: string,
): void {
  const timestamp = "2026-09-04T00:00:00.000Z";
  db.query(`INSERT INTO chats (
    id, title, kind, conversation_session_id, created_at, updated_at
  ) VALUES (?, 'Current work', 'chat', ?, ?, ?)`).run(
    sessionId,
    conversationSessionId,
    timestamp,
    timestamp,
  );
  db.query(`INSERT INTO messages (
    id, chat_id, turn_id, conversation_session_id, conversation_turn_id,
    conversation_message_id, role, text, status, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, 'assistant', ?, 'delivered', ?, ?)`).run(
    "message-private",
    sessionId,
    "turn-private",
    conversationSessionId,
    "conversation-turn-private",
    "conversation-message-private",
    "Completed conversation-message-private at /Users/private/project. Reference codex://private/task is 019fb829-8352-7151-b1e8-34199cf3a5fd. Final outcome.",
    timestamp,
    timestamp,
  );
  db.query(`INSERT INTO message_files (
    id, owner_session_id, message_id, kind, mime_type, safe_name, size_bytes,
    sha256, storage_name, created_at
  ) VALUES (?, ?, ?, 'generic', 'application/pdf', ?, 12, 'digest', ?, ?)`).run(
    "file-private",
    sessionId,
    "message-private",
    "review-summary.pdf",
    "stored-review-summary.pdf",
    timestamp,
  );
  db.query(`INSERT INTO message_attachments (
    message_id, file_id, position
  ) VALUES ('message-private', 'file-private', 0)`).run();
}
