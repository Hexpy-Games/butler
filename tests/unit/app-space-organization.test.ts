import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestAppServer } from "../../packages/butler-agent/src/test-support/app-server.ts";
import type { NavigationView, SpaceMutationResult } from "../../packages/butler-agent/src/gateways/app/interface/protocol/app-protocol.ts";

test("public space API preserves sessions through grouping, conflicts, undo and restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "butler-space-"));
  const options = { dbPath: join(dir, "app.sqlite"), butlerData: dir, projectWorkspaceRoot: join(dir, "projects"), port: 0 };
  let server = createTestAppServer(options);
  async function request(path: string, body?: unknown, method = "POST") {
    return fetch(`${server.url}${path}`, body === undefined ? undefined : {
      method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
  }
  const navigation = async (): Promise<NavigationView> => (await (await request("navigation")).json()).data;
  const mutate = async (path: string, fields: Record<string, unknown>, method = "POST"): Promise<SpaceMutationResult> => {
    const response = await request(path, { expectedRevision: (await navigation()).space.revision, ...fields }, method);
    expect(response.status).toBe(200);
    return (await response.json()).data;
  };
  try {
    const a = (await (await request("sessions", { kind: "chat", title: "보험 비교" })).json()).data.session;
    const b = (await (await request("sessions", { kind: "chat", title: "건강 검진" })).json()).data.session;
    const created = await mutate("space/groups", { title: "건강", parentKey: null });
    const parentKey = `g:${created.groupId}`;
    await mutate("space/moves", { sourceKey: `s:${a.id}`, targetKey: parentKey, position: "inside" });
    expect((await navigation()).space.nodes.find((n) => n.entityId === a.id)?.parentKey).toBe(parentKey);
    const stale = await request("space/moves", { expectedRevision: 0, sourceKey: `s:${b.id}`, targetKey: parentKey, position: "inside" });
    expect(stale.status).toBe(409);
    const grouped = await mutate("space/group-sessions", { sourceKey: `s:${b.id}`, targetKey: `s:${a.id}` });
    expect(grouped.space.nodes.filter((n) => n.parentKey === `g:${grouped.groupId}`).map((n) => n.entityId)).toEqual([a.id, b.id]);
    await mutate("space/undo", { undoToken: grouped.undoToken });
    expect((await navigation()).space.nodes.find((n) => n.entityId === a.id)?.parentKey).toBe(parentKey);
    const dissolved = await mutate(`space/groups/${created.groupId}`, {}, "DELETE");
    expect(dissolved.space.nodes.find((n) => n.entityId === a.id)?.parentKey).toBeNull();
    await mutate("space/undo", { undoToken: dissolved.undoToken });
    const beforeRestart = await navigation();
    server.stop();
    server = createTestAppServer(options);
    const after = await navigation();
    expect(after.space).toEqual(beforeRestart.space);
    expect(after.chats.map((s) => s.id)).toContain(a.id);
    expect(after.space.nodes.some((n) => n.entityId === "general")).toBe(false);
    await mutate("space/pins", { nodeKey: `s:${a.id}`, pinned: true });
    expect((await navigation()).chats.find((s) => s.id === a.id)?.pinned).toBe(true);
  } finally {
    server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("space rejects cycles and project crossing without changing placement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "butler-space-scope-"));
  const server = createTestAppServer({ dbPath: join(dir, "app.sqlite"), butlerData: dir, port: 0 });
  try {
    const store = server.store;
    const project = store.createProject({ source: "scratch", display_name: "Example" }).project;
    const chat = store.createSession({ kind: "chat" }).session;
    const cmd = (fields: Record<string, unknown>) => store.mutateSpace({ expectedRevision: store.listNavigation().space.revision, ...fields } as Parameters<typeof store.mutateSpace>[0]);
    const outer = cmd({ action: "create", title: "Outer", parentKey: null });
    const inner = cmd({ action: "create", title: "Inner", parentKey: `g:${outer.groupId}` });
    const before = store.listNavigation().space;
    expect(() => cmd({ action: "move", sourceKey: `g:${outer.groupId}`, targetKey: `g:${inner.groupId}`, position: "inside" })).toThrow();
    expect(() => cmd({ action: "move", sourceKey: `s:${chat.id}`, targetKey: `p:${project.id}`, position: "inside" })).toThrow();
    expect(store.listNavigation().space).toEqual(before);
  } finally {
    server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
