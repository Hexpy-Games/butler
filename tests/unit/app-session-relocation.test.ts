import { expect, test, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestAppServer } from "../../packages/butler-agent/src/test-support/app-server.ts";
import { SessionBindingStore } from "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import { AgentConversationStore } from "../../packages/butler-agent/src/agent/conversation/store.ts";
import { sessionHintForRow } from "../../packages/butler-agent/src/gateways/app/domain/sessions/session-read-model.ts";

test("public relocation preserves history, changes runtime scope, and recovers a crash after binding CAS", async () => {
  const dir = mkdtempSync(join(tmpdir(), "butler-relocate-api-"));
  const options = { dbPath: join(dir, "app.sqlite"), butlerData: dir, projectWorkspaceRoot: join(dir, "projects"), port: 0 };
  let server = createTestAppServer(options);
  const conversations = new AgentConversationStore({ butlerData: dir });
  const bindings = new SessionBindingStore(join(dir, "runtime", "session-store.sqlite"));
  const post = (body: unknown) => fetch(`${server.url}space/relocations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const session = server.store.createSession({ kind: "chat", title: "보험 조사" }).session;
    const project = server.store.createProject({ source: "scratch", display_name: "Research" }).project;
    const runtimeId = sessionHintForRow(session.id);
    const canonical = conversations.beginTurn({ gateway: "app", externalSessionId: runtimeId, actor: "user", turnId: "historical" });
    const originalMessage = conversations.appendUserMessage({ sessionId: canonical.session_id, turnId: canonical.id, text: "보존할 이전 대화" });
    conversations.finalizeTurn({ turnId: canonical.id });
    const first = { operationId: crypto.randomUUID(), sessionId: session.id, expectedRevision: server.store.listNavigation().space.revision, targetKey: `p:${project.id}`, position: "inside" };
    const response = await post(first);
    expect(response.status).toBe(200);
    expect(server.store.getSession(session.id).project_id).toBe(project.id);
    const moved = bindings.getBySessionId(runtimeId)!;
    expect(moved.appProjectId).toBe(project.id);
    expect(moved.ledgerProjectId).toBeTruthy();
    expect(conversations.getSessionByGatewayBinding("app", runtimeId)?.project_id).toBe(project.id);
    expect(conversations.readTurn(canonical.id)).toEqual(conversations.readTurn("historical"));
    expect((await post(first)).status).toBe(200);
    const busy = server.store.insertTurn(session.id, "thinking", "Thinking");
    const second = { ...first, operationId: crypto.randomUUID(), expectedRevision: server.store.listNavigation().space.revision, targetKey: null };
    expect((await post(second)).status).toBe(409);
    server.store.updateTurnState(busy.id, "delivered", { safeStatusLabel: "Complete" });
    const original = SessionBindingStore.prototype.compareAndSetExecutionContext;
    const crash = spyOn(SessionBindingStore.prototype, "compareAndSetExecutionContext").mockImplementation(function(this: SessionBindingStore, input) {
      const result = original.call(this, input);
      throw new Error(`simulated_process_loss_after_${result.status}`);
    });
    try { expect((await post(second)).status).toBe(500); } finally { crash.mockRestore(); }
    expect(bindings.getBySessionId(runtimeId)?.appProjectId).toBeUndefined();
    expect(server.store.getSession(session.id).project_id).toBe(project.id);
    expect(() => server.store.insertTurn(session.id, "thinking", "Thinking")).toThrow("대화를 이동");
    server.stop();
    server = createTestAppServer(options);
    expect(server.store.getSession(session.id).project_id).toBeUndefined();
    expect(server.store.listNavigation().space.nodes.find(n => n.entityId === session.id)?.parentKey).toBeNull();
    expect(conversations.getSessionByGatewayBinding("app", runtimeId)?.project_id).toBeNull();
    expect(conversations.readMessagesForTurn(canonical.id)).toEqual([originalMessage]);
    // Replaying an old turn must not restore its old project scope.
    conversations.beginTurn({ gateway: "app", externalSessionId: runtimeId, sessionId: canonical.session_id, projectId: project.id, actor: "user", turnId: canonical.id });
    expect(conversations.getSessionByGatewayBinding("app", runtimeId)?.project_id).toBeNull();
    expect((await post(second)).status).toBe(200);
    const turn = server.store.insertTurn(session.id, "thinking", "Thinking");
    expect(() => server.store.assertSessionContextAdmission(session.id, turn.id)).not.toThrow();
    expect(() => server.store.assertSessionContextAdmission(session.id, busy.id)).toThrow();
  } finally { bindings.close(); conversations.close(); server.stop(); rmSync(dir, { recursive: true, force: true }); }
});
