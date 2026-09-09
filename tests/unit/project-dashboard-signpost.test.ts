import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createProjectDashboardLedgerReader, readProjectDashboardHistory, type DashboardLedgerSnapshot } from "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/index.ts";
import { projectDashboardFacts } from "../../packages/butler-agent/src/gateways/app/domain/projects/project-dashboard-facts.ts";
import { createTestAppServer } from "../../packages/butler-agent/src/test-support/app-server.ts";
import { createButlerToolExecutor } from "../../packages/butler-agent/src/agent/tools/butler-tools.ts";
import { isMessageContent, type ResolvedProjectSource } from "../../packages/butler-agent/src/foundation/message-content.ts";
import { projectReportLocatorRevision } from "../../packages/butler-agent/src/gateways/app/domain/projects/project-report-source.ts";
import { ProjectDashboardSources } from "../../packages/butler-agent/src/gateways/app/domain/projects/project-dashboard-sources.ts";
import type { ProjectRow } from "../../packages/butler-agent/src/gateways/app/infrastructure/core/records.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const stamp = "2026-09-09T00:00:00.000Z";

function fixture(butlerData?: string) {
  const temp = butlerData ?? mkdtempSync(join(tmpdir(), "dashboard-signpost-"));
  if (!butlerData) roots.push(temp);
  const root = join(temp, "project-ledger/projects/exact-ledger");
  mkdirSync(join(root, "index"), { recursive: true });
  writeFileSync(join(root, "project.json"), JSON.stringify({ id: "exact-ledger" }));
  const records = [record("W-1", "work", "blocked", null, "work/W-1/work.md"),
    record("T-1", "task", "done", "W-1", "work/W-1/tasks/T-1/task.md"),
    record("W-MISSING", "work", "done", null, "work/W-MISSING/work.md"),
    record("REPORT-LONG", "report", "done", null, "reports/report-long.md")];
  for (const item of records.filter((record) => record.id !== "W-MISSING")) {
    const path = join(root, item.path.split("exact-ledger/")[1]!);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `---\nschema: "project-ledger.${item.kind}.v1"\n${Object.entries(item)
      .filter(([, value]) => value !== null).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n${item.kind === "report" ? "Public report line.\n".repeat(4000) + "REPORT END" : "Public source\n"}`);
  }
  writeFileSync(join(root, "index/project.json"), JSON.stringify({ schema: "project-ledger.index.v1",
    project: { id: "exact-ledger" }, records }));
  return { temp, root };
}
function record(id: string, kind: string, status: string, parentId: string | null, path: string) {
  return { id, kind, title: id, status, parentId, spec: null, priority: 30, updatedAt: stamp,
    path: `project-ledger/projects/exact-ledger/${path}` };
}

test("exact App-to-Ledger binding; missing source stays unknown, blocked parent is not completed by tasks", async () => {
  const { temp } = fixture();
  const read = createProjectDashboardLedgerReader(temp);
  const snapshot = await read("app-id-is-different", "exact-ledger");
  const facts = projectDashboardFacts(snapshot);
  expect(facts.status).toBe("ready");
  if (facts.status !== "ready") throw new Error("facts missing");
  expect(facts.progress).toEqual({ completed: 0, open: 0, blocked: 1, abandoned: 0, unknown: 1 });
  expect(facts.remaining[0]?.taskProgress).toEqual({ done: 1, total: 1 });
  expect(await read("app-id-is-different", "exact-ledger")).toBe(snapshot);
  await expect(read("app-id-is-different", "../exact-ledger")).rejects.toThrow("identity_invalid");
});

test("completed managed execution in official review is not reopened or counted as remaining", () => {
  // Pure policy test; strict manifest/proof validation is exercised by the adapter reader tests.
  const snapshot = { revision: "revision", observedAt: stamp, records: [], works: [{
    record: record("W-MANAGED", "work", "review", null, "work/W-MANAGED/work.md"),
    revision: "source", availability: "ready", managed: { status: "completed" },
  }] } as unknown as DashboardLedgerSnapshot;
  const facts = projectDashboardFacts(snapshot);
  expect(facts.status === "ready" && facts.progress.completed).toBe(1);
  expect(facts.status === "ready" && facts.remaining).toEqual([]);
});

test("remaining Work prioritizes blockers and actual live sessions without deriving execution from a Ledger label", () => {
  const snapshot = { revision: "r", observedAt: stamp, records: [], works: [
    { record: { ...record("newer", "work", "in_progress", null, "work/newer/work.md"), updatedAt: "2026-09-10" }, availability: "ready", managed: null },
    { record: record("live", "work", "in_progress", null, "work/live/work.md"), availability: "ready", managed: { status: "open", sessionId: "s" } },
    { record: record("blocked", "work", "blocked", null, "work/blocked/work.md"), availability: "ready", managed: null },
  ] } as unknown as DashboardLedgerSnapshot;
  const live = projectDashboardFacts(snapshot, () => ({ active_turn_state: "thinking" } as any));
  expect(live.remaining.map((work) => work.id)).toEqual(["blocked", "live", "newer"]);
  const done = projectDashboardFacts(snapshot, () => ({ active_turn_state: "delivered" } as any));
  expect(done.remaining.map((work) => work.id)).toEqual(["blocked", "newer", "live"]);
});

test("Task metadata refreshes before an index rebuild and unreadable Tasks are never done", async () => {
  const { temp, root } = fixture();
  const read = createProjectDashboardLedgerReader(temp);
  const taskPath = join(root, "work/W-1/tasks/T-1/task.md");
  await read("app", "exact-ledger");
  writeFileSync(taskPath, readFileSync(taskPath, "utf8").replace('status: "done"', 'status: "in_progress"'));
  const refreshed = projectDashboardFacts(await read("app", "exact-ledger"));
  expect(refreshed.status === "ready" && refreshed.remaining[0]?.taskProgress).toEqual({ done: 0, total: 1 });
  writeFileSync(taskPath, "damaged source");
  const damaged = await read("app", "exact-ledger");
  expect(damaged.records.find((record) => record.id === "T-1")).toMatchObject({ status: "unknown", unavailable: true });
});

test("important materials use explicit active Work relations, prefer plans, and retain only the latest related report", async () => {
  const { temp, root } = fixture();
  const index = JSON.parse(readFileSync(join(root, "index/project.json"), "utf8"));
  const additions = [record("PLAN-CURRENT", "plan", "active", "W-1", "plans/current.md"),
    record("PLAN-CLOSED", "plan", "done", "W-1", "plans/closed.md"),
    record("REPORT-OLDER", "report", "done", "W-1", "reports/older.md"),
    { ...record("REPORT-NEWER", "report", "done", "W-1", "reports/newer.md"), updatedAt: "2026-09-10T00:00:00.000Z" }];
  for (const item of additions) {
    const path = join(root, item.path.split("exact-ledger/")[1]!); mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `---\nschema: "project-ledger.${item.kind}.v1"\n${Object.entries(item).filter(([, value]) => value !== null).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\nPublic material\n`);
  }
  index.records.push(...additions); writeFileSync(join(root, "index/project.json"), JSON.stringify(index));
  const db = new Database(":memory:");
  try {
    const sources = new ProjectDashboardSources({ butlerData: temp, db, readLedger: createProjectDashboardLedgerReader(temp),
      getProjectRow: () => ({ id: "app", ledger_project_id: "exact-ledger", dashboard_preferences_json: null } as ProjectRow) });
    const important = await sources.list("app", { important: true, limit: 5 });
    expect(important.status === "ready" && important.documents.map((doc) => doc.id)).toEqual(["PLAN-CURRENT", "REPORT-NEWER"]);
    const all = await sources.list("app", { limit: 50 });
    expect(all.status === "ready" && all.documents.map((doc) => doc.id)).toContain("REPORT-OLDER");
    expect(all.status === "ready" && all.documents.map((doc) => doc.id)).toContain("REPORT-LONG");
  } finally { db.close(); }
});

test("existing dashboard HTTP route resolves exact binding and exposes unavailable without guessing", async () => {
  const temp = mkdtempSync(join(tmpdir(), "dashboard-public-")); roots.push(temp);
  const butlerData = join(temp, ".butler");
  fixture(butlerData);
  const dbPath = join(temp, "app.sqlite");
  const server = createTestAppServer({ dbPath, butlerData, projectWorkspaceRoot: join(temp, "workspace"), port: 0 });
  const db = new Database(dbPath);
  try {
    const created = await fetch(`${server.url}projects`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "scratch", display_name: "Not the Ledger ID" }) }).then((response) => response.json());
    const projectId = created.data.project.id;
    db.query("UPDATE projects SET ledger_project_id = ? WHERE id = ?").run("exact-ledger", projectId);
    const response = await fetch(`${server.url}projects/${projectId}/dashboard`);
    expect(response.status).toBe(200);
    const view = (await response.json()).data;
    expect(view.overview.progress.blocked).toBe(1);
    expect(view.overview.progress.unknown).toBe(1);
    expect(JSON.stringify(view)).not.toContain(temp);
    const patchPreferences = (body: unknown) => fetch(`${server.url}projects/${projectId}/dashboard/preferences`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    expect((await patchPreferences({ expectedRevision: 0, description: "A non-coding research project" })).status).toBe(200);
    expect((await patchPreferences({ expectedRevision: 0, description: "Stale edit" })).status).toBe(409);
    const described = (await fetch(`${server.url}projects/${projectId}/dashboard`).then((response) => response.json())).data;
    expect(described.description).toBe("A non-coding research project");
    expect(described.preferences.revision).toBe(1);
    const board = await fetch(`${server.url}projects/${projectId}/dashboard/records?kind=work&limit=1`).then((response) => response.json());
    expect(board.data.total).toBe(2);
    expect(board.data.items).toHaveLength(1);
    expect(board.data.nextCursor).toBeString();
    const second = await fetch(`${server.url}projects/${projectId}/dashboard/records?kind=work&limit=1&cursor=${board.data.nextCursor}`)
      .then((response) => response.json());
    expect(second.data.items[0].id).not.toBe(board.data.items[0].id);
    expect(second.data.nextCursor).toBeNull();
    expect((await fetch(`${server.url}projects/${projectId}/dashboard/records?kind=task&cursor=${board.data.nextCursor}`)).status).toBe(400);
    const tasks = await fetch(`${server.url}projects/${projectId}/dashboard/records?kind=task&parent=W-1`).then((response) => response.json());
    expect(tasks.data.items[0]).toMatchObject({ id: "T-1", kind: "task", parentId: "W-1", lane: "done", actionProgress: null });
    expect((await fetch(`${server.url}projects/${projectId}/dashboard/records?kind=invalid`)).status).toBe(400);
    expect((await fetch(`${server.url}projects/${projectId}/dashboard/records?limit=10000`)).status).toBe(400);
    const materials = await fetch(`${server.url}projects/${projectId}/dashboard/materials`).then((response) => response.json());
    const important = () => fetch(`${server.url}projects/${projectId}/dashboard/materials?important=true`).then((response) => response.json());
    // A recent orphan report is not automatically an important project material.
    expect((await important()).data.documents).toEqual([]);
    const metadata = materials.data.documents[0];
    const allMaterials = (await fetch(`${server.url}projects/${projectId}/dashboard/materials?all=true&limit=1`).then((response) => response.json())).data;
    expect((await fetch(`${server.url}projects/${projectId}/dashboard/materials?cursor=${allMaterials.nextCursor}`)).status).toBe(409);
    expect(metadata).toMatchObject({ id: "REPORT-LONG", kind: "report", markdown: "" });
    const sourceUrl = `${server.url}projects/${projectId}/dashboard/source?kind=report&id=REPORT-LONG`;
    let page = (await fetch(`${sourceUrl}&revision=${metadata.revision}`).then((response) => response.json())).data;
    expect(page.truncated).toBe(true);
    const revision = page.revision;
    expect((await patchPreferences({ expectedRevision: 1, pinnedSourceRefs: [{ kind: "report", id: "REPORT-LONG", revision: metadata.revision }] })).status).toBe(200);
    expect((await important()).data.documents.map((doc: { id: string }) => doc.id)).toEqual(["REPORT-LONG"]);
    expect((await fetch(`${server.url}projects/${projectId}/dashboard/materials?all=true&cursor=${allMaterials.nextCursor}`)).status).toBe(409);
    let body = page.markdown;
    while (page.nextCursor) {
      page = (await fetch(`${sourceUrl}&revision=${revision}&cursor=${page.nextCursor}`).then((response) => response.json())).data;
      body += page.markdown;
    }
    expect(body).toBe("Public report line.\n".repeat(4000) + "REPORT END");
    const reportPath = join(butlerData, "project-ledger/projects/exact-ledger/reports/report-long.md");
    writeFileSync(reportPath, readFileSync(reportPath, "utf8").replace("REPORT END", "CHANGED END"));
    expect((await fetch(`${sourceUrl}&revision=${revision}`)).status).toBe(409);
    expect((await patchPreferences({ expectedRevision: 2, pinnedSourceRefs: [{ kind: "report", id: "REPORT-LONG", revision }] })).status).toBe(200);
    expect((await patchPreferences({ expectedRevision: 3, pinnedSourceRefs: [{ kind: "report", id: "OTHER", revision }] })).status).toBe(404);
    expect((await fetch(`${server.url}projects/${projectId}/dashboard/source?kind=report&id=OTHER&revision=${revision}`)).status).toBe(404);
    for (const [id, owner, role, status] of [
      ["published-1", projectId, "assistant", "delivered"], ["published-2", projectId, "assistant", "delivered"],
      ["uploaded-input", projectId, "user", "sent"], ["unfinished", projectId, "assistant", "streaming"],
      ["other-project", "not-this-project", "assistant", "delivered"],
    ]) {
      db.query("INSERT INTO chats (id,title,kind,project_id,created_at,updated_at) VALUES (?,?,?,?,?,?)")
        .run(id!, `Session ${id}`, "project", owner!, stamp, stamp);
      db.query("INSERT INTO messages (id,chat_id,role,text,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
        .run(id!, id!, role!, "Private message body is not a catalog entry", status!, stamp, stamp);
      db.query("INSERT INTO message_files (id,kind,mime_type,safe_name,size_bytes,sha256,storage_name,created_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(id!, "file", "text/plain", `${id}.txt`, 5, "a".repeat(64), "private-storage-name", stamp);
      db.query("INSERT INTO message_attachments (message_id,file_id,position) VALUES (?,?,0)").run(id!, id!);
    }
    const artifactPage = (await fetch(`${server.url}projects/${projectId}/dashboard/artifacts?limit=1`).then((response) => response.json())).data;
    expect(artifactPage.items.map((item: { file_id: string }) => item.file_id)).toEqual(["published-2"]);
    expect(JSON.stringify(artifactPage)).not.toContain("Private message body");
    expect(JSON.stringify(artifactPage)).not.toContain("private-storage-name");
    const olderArtifacts = (await fetch(`${server.url}projects/${projectId}/dashboard/artifacts?limit=1&cursor=${artifactPage.nextCursor}`).then((response) => response.json())).data;
    expect(olderArtifacts.items.map((item: { file_id: string }) => item.file_id)).toEqual(["published-1"]);
    expect(olderArtifacts.nextCursor).toBeNull();
    const reportBody = "Public report detail.\n".repeat(2000) + "EXACT REPORT TAIL";
    db.query("UPDATE messages SET text=? WHERE id='published-1'").run(reportBody);
    const locator = projectReportLocatorRevision({ id: "published-1", chat_id: "published-1", updated_at: stamp,
      chars: reportBody.length, excerpt: reportBody.slice(0, 1200) });
    const reportUrl = `${server.url}projects/${projectId}/dashboard/source?kind=message&id=published-1`;
    const firstReport = (await fetch(`${reportUrl}&revision=${locator}`).then((response) => response.json())).data;
    expect(firstReport.truncated).toBe(true);
    const lastReport = (await fetch(`${reportUrl}&revision=${firstReport.revision}&cursor=${firstReport.nextCursor}`).then((response) => response.json())).data;
    expect(firstReport.markdown + lastReport.markdown).toBe(reportBody);
    expect((await fetch(`${reportUrl.replace("published-1", "other-project")}&revision=${locator}`)).status).toBe(404);
    expect((await fetch(`${reportUrl.replace("published-1", "unfinished")}&revision=${locator}`)).status).toBe(404);
    db.query("UPDATE messages SET text=?,updated_at=? WHERE id='published-1'").run("Changed", "2026-09-10");
    expect((await fetch(`${reportUrl}&revision=${locator}`)).status).toBe(409);
    db.query("UPDATE message_files SET id='file-published-1' WHERE id='published-1'").run();
    db.query("UPDATE message_attachments SET file_id='file-published-1' WHERE file_id='published-1'").run();
    const artifactSource = `${server.url}projects/${projectId}/dashboard/source?kind=artifact&id=artifact-file-published-1&revision=${"a".repeat(64)}`;
    expect((await fetch(artifactSource)).status).toBe(200);
    expect((await fetch(artifactSource.replace("a".repeat(64), "b".repeat(64)))).status).toBe(409);
    expect((await fetch(artifactSource.replace(projectId, "different-project"))).status).toBe(404);
    expect((await patchPreferences({ expectedRevision: 3, pinnedSourceRefs: [{ kind: "artifact", id: "artifact-file-published-1", revision: "a".repeat(64) }] })).status).toBe(200);
    const pinnedMaterials = (await fetch(`${server.url}projects/${projectId}/dashboard/materials`).then((r) => r.json())).data;
    expect(pinnedMaterials.documents[0]).toMatchObject({ id: "artifact-file-published-1", document_type: "artifact", revision: "a".repeat(64) });
    expect(pinnedMaterials.documents[0].artifact.file_id).toBe("file-published-1");
    const published = await server.store.createMessageFile({ ownerSessionId: "published-2", name: "result.txt", mimeType: "text/plain", bytes: "Complete artifact content" });
    db.query("UPDATE message_attachments SET file_id=? WHERE message_id='published-2'").run(published.file.file_id);
    db.query("UPDATE message_files SET message_id='published-2' WHERE id=?").run(published.file.file_id);
    const copyArtifact = (revision: string) => fetch(`${server.url}projects/${projectId}/dashboard/attachment`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: `artifact-${published.file.file_id}`, revision }),
    });
    expect((await copyArtifact("b".repeat(64))).status).toBe(409);
    const copiedResponse = await copyArtifact(published.file.sha256);
    expect(copiedResponse.status).toBe(201);
    const copied = (await copiedResponse.json()).data.file;
    expect(copied.file_id).not.toBe(published.file.file_id);
    expect(copied.sha256).toBe(published.file.sha256);
    expect(server.store.getMessageFileDownload(copied.file_id).bytes.toString()).toBe("Complete artifact content");
    expect(db.query("SELECT owner_session_id,message_id FROM message_files WHERE id=?").get(published.file.file_id))
      .toEqual({ owner_session_id: "published-2", message_id: "published-2" });
    db.query("UPDATE messages SET status='streaming' WHERE id='published-2'").run();
    expect((await copyArtifact(published.file.sha256)).status).toBe(404);
    db.query("UPDATE messages SET status='delivered' WHERE id='published-2'").run();
    db.query("UPDATE projects SET ledger_project_id = NULL WHERE id = ?").run(projectId);
    const unavailable = await fetch(`${server.url}projects/${projectId}/dashboard`).then((response) => response.json());
    expect(unavailable.data.overview).toEqual({ status: "unavailable", reason: "unbound" });
    expect(unavailable.data.documents).toEqual([]);
    expect((await fetch(`${server.url}projects/${projectId}/dashboard/artifacts`).then((response) => response.json())).data.items).toHaveLength(2);
  } finally { db.close(); server.stop(); }
});

test("history pages are stable on append, bounded, and never expose private event payloads", () => {
  const { root } = fixture();
  const event = (id: string) => JSON.stringify({ type: "work_updated", id, ts: stamp, private: "must-not-expose" });
  const path = join(root, "ledger.jsonl");
  writeFileSync(path, `\n${event("W-1")}\ninvalid\n${JSON.stringify({ type: "index_written", ts: stamp })}\n${event("W-2")}\n${event("W-3")}\n`);
  const first = readProjectDashboardHistory(root, undefined, 1);
  expect(first.events.map((item) => item.recordId)).toEqual(["W-3"]);
  appendFileSync(path, `${event("W-4")}\n`);
  const second = readProjectDashboardHistory(root, first.nextCursor!, 2);
  expect(second.events.map((item) => item.recordId)).toEqual(["W-2", "W-1"]);
  expect(JSON.stringify(second)).not.toContain("must-not-expose");
  const last = second.nextCursor ? readProjectDashboardHistory(root, second.nextCursor, 2) : second;
  expect(last.nextCursor).toBeNull();
  writeFileSync(path, `${event("W-0")}\n${"invalid but bounded\n".repeat(20_000)}${event("W-5")}\n`);
  let page = readProjectDashboardHistory(root, undefined, 50);
  const ids = page.events.map((item) => item.recordId);
  for (let count = 0; page.nextCursor && count < 5; count++) {
    page = readProjectDashboardHistory(root, page.nextCursor, 50);
    ids.push(...page.events.map((item) => item.recordId));
  }
  expect(ids).toEqual(["W-5", "W-0"]);
  expect(page.nextCursor).toBeNull();
});

test("project references travel through HTTP acceptance and durable queue; original tool reads the accepted snapshot", async () => {
  const temp = mkdtempSync(join(tmpdir(), "dashboard-source-queue-")); roots.push(temp);
  const { root } = fixture(temp);
  const dbPath = join(temp, "app.sqlite");
  const server = createTestAppServer({ dbPath, butlerData: temp, projectWorkspaceRoot: join(temp, "workspace"), port: 0 });
  const db = new Database(dbPath);
  const post = (path: string, body: unknown) => fetch(`${server.url}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    const created = await post("projects", { source: "scratch", display_name: "Source project" }).then((response) => response.json());
    const projectId = created.data.project.id;
    db.query("UPDATE projects SET ledger_project_id = ? WHERE id = ?").run("exact-ledger", projectId);
    db.query("INSERT INTO chats (id,title,kind,project_id,created_at,updated_at) VALUES (?,?,?,?,?,?)").run("source-chat", "Source chat", "project", projectId, stamp, stamp);
    const metadata = (await fetch(`${server.url}projects/${projectId}/dashboard/materials`).then((response) => response.json())).data.documents[0];
    const reference = { type: "project_source_ref", projectId, titleSnapshot: "Client title is not authoritative",
      source: { kind: "report", id: metadata.id, revision: metadata.revision } };
    const request = { chat_id: "source-chat", client_message_id: "client-source-proof", text: "Read this",
      content_parts: { version: 1, parts: [{ type: "text", text: "Read this " }, reference] } };
    expect(isMessageContent(request.content_parts)).toBe(true);
    expect(isMessageContent({ version: 1, parts: [{ ...reference, source: { ...reference.source, revision: "fake" } }] })).toBe(false);
    const response = await post("messages", request);
    expect(response.status).toBe(202);
    const accepted = (await response.json()).data;
    expect(accepted.accepted.content_parts).toEqual(request.content_parts);
    const row = db.query<{ project_source_refs_json: string }, [string]>("SELECT project_source_refs_json FROM session_queued_messages WHERE dispatched_message_id = ?").get(accepted.accepted.id)!;
    const sources: ResolvedProjectSource[] = JSON.parse(row.project_source_refs_json);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.title).toBe("REPORT-LONG");
    expect(sources[0]!.excerptTruncated).toBe(true);
    const report = join(root, "reports/report-long.md");
    writeFileSync(report, readFileSync(report, "utf8").replace("REPORT END", "LATER VERSION"));
    const execute = createButlerToolExecutor({ butlerHome: temp, butlerData: temp, projectSources: sources });
    const firstPage = await execute({ name: "read_project_source", args: { file_id: sources[0]!.originalRef.fileId, cursor: "" }, rawArguments: "{}" }) as { ok: boolean; content: string };
    expect(firstPage.ok).toBe(true);
    expect(firstPage.content).toStartWith("Public report line.");
    const args: Record<string, unknown> = { file_id: sources[0]!.originalRef.fileId };
    let body = "";
    for (let count = 0; count < 10; count++) {
      const page = await execute({ name: "read_project_source", args, rawArguments: JSON.stringify(args) }) as { ok: boolean; content: string; next_cursor: string | null };
      expect(page.ok).toBe(true); body += page.content;
      if (!page.next_cursor) break;
      args.cursor = page.next_cursor;
    }
    expect(body).toBe("Public report line.\n".repeat(4000) + "REPORT END");
    expect((await post("messages", request)).status).toBe(202);
    expect((await post("messages", { ...request, client_message_id: "client-stale-source" })).status).toBe(409);
    const forged = await execute({ name: "read_project_source", args: { file_id: "file-not-admitted" }, rawArguments: "{}" }) as { ok: boolean };
    expect(forged.ok).toBe(false);
    expect((await post("messages", { ...request, client_message_id: "client-wrong-project", content_parts: { version: 1,
      parts: [{ ...reference, projectId: "different" }] } })).status).toBe(409);
  } finally { db.close(); server.stop(); }
});
