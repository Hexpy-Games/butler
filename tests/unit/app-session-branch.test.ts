import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestAppServer } from "../../packages/butler-agent/src/test-support/app-server.ts";
import { AppSessionBranchStore } from "../../packages/butler-agent/src/gateways/app/domain/sessions/session-branch-store.ts";
import { AgentConversationStore } from "../../packages/butler-agent/src/agent/conversation/store.ts";
import { readBranchAnswer, resolveBranchSessionId } from "../../packages/butler-agent/src/gateways/app/domain/sessions/session-branch-context.ts";
import { sessionHintForRow } from "../../packages/butler-agent/src/gateways/app/domain/sessions/session-read-model.ts";

test("branch resolves canonical answer via its public turn outcome without relying on optional App projection columns", () => {
  const directory = mkdtempSync(join(tmpdir(), "butler-branch-answer-"));
  const server = createTestAppServer({ dbPath: join(directory, "app.sqlite"), butlerData: directory, port: 0 });
  const canonical = new AgentConversationStore({ butlerData: directory });
  try {
    const source = server.store.createSession({ kind: "chat", title: "합의" }).session;
    const other = server.store.createSession({ kind: "chat", title: "다른 대화" }).session;
    const turn = canonical.beginTurn({ gateway: "app", externalSessionId: sessionHintForRow(source.id), actor: "user" });
    for (const id of [source.id, sessionHintForRow(source.id), turn.session_id]) {
      expect(resolveBranchSessionId(server.store.db, directory, id)).toBe(source.id);
    }
    const answer = canonical.appendAssistantMessage({ sessionId: turn.session_id, turnId: turn.id, text: "회의 메모 정리" });
    canonical.finalizeTurn({ turnId: turn.id, outcomeCapsule: { sessionId: turn.session_id, turnId: turn.id,
      generation: 1, outcome: "delivered", publicAssistantMessageId: answer.id } });
    const visible = server.store.insertMessage(source.id, "assistant", "회의 메모 정리", "delivered");
    server.store.db.query("UPDATE messages SET turn_id=? WHERE id=?").run(turn.id, visible.id);
    const resolved = readBranchAnswer(server.store.db, directory, source.id, answer.id);
    expect(resolved?.id).toBe(visible.id);
    expect(resolved?.conversation_message_id).toBe(answer.id);
    expect(readBranchAnswer(server.store.db, directory, source.id, visible.id)?.conversation_message_id).toBe(answer.id);
    expect(readBranchAnswer(server.store.db, directory, other.id, answer.id)).toBeNull();
    expect(readBranchAnswer(server.store.db, directory, source.id, "unknown-answer")).toBeNull();
  } finally { canonical.close(); server.stop(); rmSync(directory, { recursive: true, force: true }); }
});

test("branch reservation preserves one target and seed through failed provisioning without fabricating messages", async () => {
  const directory = mkdtempSync(join(tmpdir(), "butler-branch-"));
  const path = join(directory, "app.sqlite");
  const server = createTestAppServer({ dbPath: path, butlerData: directory, port: 0 });
  const db = server.store.db;
  try {
    const source = server.store.createSession({ kind: "chat", title: "보험" }).session;
    server.store.insertMessage(source.id, "user", "가입 조건을 비교해 주세요.", "sent");
    const message = server.store.insertMessage(source.id, "assistant", "보험의 가입 조건은 다음과 같습니다.", "delivered");
    let summaries = 0, fail = true, published = 0;
    const options = {
      db, getSession: (id: string) => server.store.getSession(id),
      butlerData: directory,
      getMessage: (id: string) => server.store.listMessages(source.id).find(message => message.id === id)!,
      createSession: (request: Parameters<typeof server.store.createSession>[0]) => server.store.createSession(request, { emitCreated: false }).session,
      createProject: (name: string) => server.store.createProject({ source: "scratch", display_name: name }).project,
      provision: async () => { if (fail) throw new Error("provision unavailable"); },
      publish: (id: string) => { published++; server.store.publishSessionCreated(id); },
      summarize: async () => { summaries++; return { summary: "보험 가입 조건 비교를 이어갑니다.", excerptTruncated: false }; },
    };
    const request = { requestId: "branch-one", sourceSessionId: source.id, sourceMessageId: message.id, title: "보험 비교", destination: { kind: "chat" as const } };
    await expect(new AppSessionBranchStore(options).branch(request)).rejects.toThrow("provision unavailable");
    const target = db.query<{ target_session_id: string }, []>("SELECT target_session_id FROM app_session_branches").get()!.target_session_id;
    expect(server.store.listNavigation().chats.some(chat => chat.id === target)).toBe(false);
    expect(() => server.store.insertTurn(target, "queued", "Queued")).toThrow("session_branch_preparing");
    fail = false;
    const resumed = new AppSessionBranchStore(options);
    const result = await resumed.branch(request);
    expect(result.session.id).toBe(target);
    expect(result.seed.sourceMessageId).toBe(message.id);
    expect(server.store.listMessages(target)).toEqual([]);
    expect(server.store.listNavigation().chats.some(chat => chat.id === target)).toBe(true);
    expect(summaries).toBe(1);
    expect(published).toBe(1);
    expect((await resumed.branch(request)).session.id).toBe(target);
    expect(published).toBe(1);
    await expect(resumed.branch({ ...request, title: "다른 요청" })).rejects.toThrow();
  } finally { server.stop(); rmSync(directory, { recursive: true, force: true }); }
});
