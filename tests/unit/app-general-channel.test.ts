import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestAppServer } from "../../packages/butler-agent/src/test-support/app-server.ts";
import { sessionLifecycleStopWithAuthorityClose } from "../../packages/butler-agent/src/gateways/app/application/session-authority-operational-close.ts";

test("permanent general rejects lifecycle changes while same-title topics remain archivable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "butler-general-"));
  const options = { dbPath: join(dir, "app.sqlite"), butlerData: dir, port: 0 };
  let server = createTestAppServer(options);
  try {
    const twin = server.store.createSession({ kind: "chat", title: "일반" }).session;
    const sent = await fetch(`${server.url}messages`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: "general", text: "복구 후에도 남아야 하는 기존 대화" }),
    });
    expect(sent.ok).toBe(true);
    const messageCount = server.store.listMessages("general").length;
    expect(messageCount).toBeGreaterThan(0);
    for (const [path, method, body] of [
      ["sessions/general/archive", "POST", {}],
      ["sessions/general", "PATCH", { archived: true }],
      ["sessions/general", "DELETE", undefined],
      ["sessions/general?permanent=true", "DELETE", undefined],
    ] as const) {
      const response = await fetch(`${server.url}${path}`, {
        method, headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe("general_channel_protected");
    }
    let closed = false;
    expect(() => sessionLifecycleStopWithAuthorityClose({
      authority: { closeSelfSession: () => { closed = true; } } as never,
      store: server.store, sessionId: "general", stop: "archive",
    })).toThrow("일반 채널");
    expect(closed).toBe(false);
    expect(() => server.store.archiveSession("general")).toThrow("일반 채널");
    expect(() => server.store.deleteSessionPermanent("general")).toThrow("일반 채널");
    expect(() => server.store.rollbackSessionCreation("general")).toThrow("일반 채널");
    server.store.archiveSession(twin.id);
    server.stop();

    // Reproduce the pre-r4 persisted state, not an API path that is now forbidden.
    const db = new Database(options.dbPath);
    db.query("UPDATE chats SET archived=1 WHERE id='general'").run();
    const before = db.query("SELECT created_at,conversation_session_id FROM chats WHERE id='general'").get();
    db.close();
    server = createTestAppServer(options);
    expect(server.store.getSession("general").archived).toBe(false);
    expect(server.store.getSession(twin.id).archived).toBe(true);
    expect(server.store.listMessages("general")).toHaveLength(messageCount);
    expect(server.store.listMessages("general").some(m => m.text === "복구 후에도 남아야 하는 기존 대화")).toBe(true);
    expect(server.store.listNavigation().chats.filter((c) => c.id === "general")).toHaveLength(1);
    const reopened = new Database(options.dbPath, { readonly: true });
    expect(reopened.query("SELECT created_at,conversation_session_id FROM chats WHERE id='general'").get()).toEqual(before);
    reopened.close();
  } finally {
    server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
