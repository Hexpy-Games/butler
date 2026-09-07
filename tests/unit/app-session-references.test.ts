import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestAppServer } from "../../packages/butler-agent/src/test-support/app-server.ts";
import type { MessageContent } from "../../packages/butler-agent/src/foundation/message-content.ts";

test("public message and queue preserve reference identity across restart and reject changed replays", async () => {
  const directory = mkdtempSync(join(tmpdir(), "butler-references-"));
  const options = { dbPath: join(directory, "app.sqlite"), butlerData: directory, port: 0 };
  let server = createTestAppServer(options);
  const request = (path: string, body?: unknown, method = "POST") => fetch(`${server.url}${path}`, body === undefined ? {} : {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    const source = server.store.createSession({ kind: "chat", title: "보험" }).session;
    const target = server.store.createSession({ kind: "chat", title: "비교" }).session;
    const content: MessageContent = { version: 1, parts: [
      { type: "text", text: "이 대화 " },
      { type: "session_ref", sessionId: source.id, titleSnapshot: "보험" },
      { type: "text", text: " 참고해 주세요\n조건 비교" },
    ] };
    const sent = await request("messages", { chat_id: target.id, text: "untrusted projection", content_parts: content, client_message_id: "refs-one" });
    expect(sent.status).toBe(202);
    const result = (await sent.json()).data;
    expect(result.accepted.content_parts).toEqual(content);
    expect(result.accepted.text).toBe("이 대화 @보험 참고해 주세요\n조건 비교");
    const replay = await request("messages", { chat_id: target.id, text: "ignored", content_parts: content, client_message_id: "refs-one" });
    expect(replay.status).toBe(202);
    const changed = { ...content, parts: content.parts.map(part => part.type === "session_ref" ? { ...part, sessionId: target.id } : part) };
    const conflict = await request("messages", { chat_id: target.id, text: result.accepted.text, content_parts: changed, client_message_id: "refs-one" });
    expect(conflict.status).toBe(409);
    const queued = await request("session-queue", { chat_id: target.id, text: "ignored", content_parts: content });
    expect(queued.status).toBe(202);
    const queuedMessage = (await queued.json()).data.queued_messages[0];
    expect(queuedMessage.content_parts).toEqual(content);
    const edited = await request(`session-queue/${queuedMessage.id}`, { text: "ignored", content_parts: changed }, "PATCH");
    expect(edited.status).toBe(200);
    expect((await edited.json()).data.queued_messages[0].content_parts).toEqual(changed);
    server.stop(); server = createTestAppServer(options);
    expect(server.store.listMessages(target.id)[0]?.content_parts).toEqual(content);
    const invalid = await request("messages", { chat_id: target.id, text: "", content_parts: { version: 1, parts: [{ type: "session_ref", sessionId: null }] } });
    expect(invalid.status).toBe(400);
  } finally { server.stop(); rmSync(directory, { recursive: true, force: true }); }
});
