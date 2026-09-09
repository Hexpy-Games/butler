import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestAppServer } from "../../packages/butler-agent/src/test-support/app-server.ts";
import { Database } from "bun:sqlite";
import { AppSpaceOrganization } from "../../packages/butler-agent/src/gateways/app/domain/sessions/space-organization.ts";

test("new root/project sessions and smart grouping prepend without reordering siblings, including restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "sidebar-new-session-"));
  const options = { dbPath: join(dir, "app.sqlite"), butlerData: dir, port: 0 };
  let server = createTestAppServer(options);
  const children = (parent: string | null) => server.store.listNavigation().space.nodes
    .filter((node) => node.parentKey === parent).sort((a, b) => a.position - b.position).map((node) => node.entityId);
  try {
    const a = server.store.createSession({ kind: "chat", title: "First" }).session;
    const b = server.store.createSession({ kind: "chat", title: "Second" }).session;
    expect(children(null)).toEqual([b.id, a.id]);
    const project = server.store.createProject({ source: "scratch", display_name: "Project" }).project;
    const p1 = server.store.createSession({ kind: "project", project_id: project.id }).session;
    const p2 = server.store.createSession({ kind: "project", project_id: project.id }).session;
    expect(children(`p:${project.id}`)).toEqual([p2.id, p1.id]);
    const before = children(null);
    server.stop(); server = createTestAppServer(options);
    expect(children(null)).toEqual(before);
    const c = server.store.createSession({ kind: "chat" }).session;
    expect(children(null)).toEqual([c.id, ...before]);
    const db = new Database(options.dbPath);
    try {
      const organization = new AppSpaceOrganization(db, () => {});
      const grouped = organization.execute({ action: "group", sourceKey: `s:${c.id}`, targetKey: `s:${a.id}`,
        expectedRevision: organization.read().revision }, "smart", "Topic");
      const parent = `g:${grouped.groupId}`;
      expect(children(parent)).toEqual([c.id, a.id]);
      const newest = server.store.createSession({ kind: "chat" }).session;
      organization.execute({ action: "move", sourceKey: `s:${newest.id}`, targetKey: parent, position: "inside",
        expectedRevision: organization.read().revision }, "smart", "Topic");
      expect(children(parent)).toEqual([newest.id, c.id, a.id]);
    } finally { db.close(); }
  } finally { server.stop(); rmSync(dir, { recursive: true, force: true }); }
});
