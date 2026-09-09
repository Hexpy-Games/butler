import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateAppStoreSchema } from "../../packages/butler-agent/src/gateways/app/infrastructure/core/schema.ts";
import { buildProjectBriefingPack, type ProjectBriefingPack } from "../../packages/butler-agent/src/gateways/app/domain/projects/project-briefing-facts.ts";
import { validateProjectBriefing } from "../../packages/butler-agent/src/gateways/app/domain/projects/project-briefing-generation.ts";
import { ProjectBriefingStore } from "../../packages/butler-agent/src/gateways/app/domain/projects/project-briefing-store.ts";
import type { DashboardBriefingContent } from "../../packages/butler-agent/src/gateways/app/interface/protocol/session-dashboard-contract.ts";
import type { DashboardLedgerSnapshot } from "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/index.ts";
import { initializeProjectIntroduction } from "../../packages/butler-agent/src/gateways/app/domain/projects/project-introduction.ts";
import { readProjectSourceFeedback } from "../../packages/butler-agent/src/gateways/app/domain/projects/project-source-feedback.ts";

function fixture() {
  const db = new Database(":memory:"); migrateAppStoreSchema(db);
  db.query("INSERT OR IGNORE INTO projects(id,display_name,status,workspace_path,workspace_label,safe_path_label,created_at,updated_at) VALUES ('briefing-p','P','ready','','','','2026-09-09','2026-09-09')").run();
  const snapshot: DashboardLedgerSnapshot = { revision: "a".repeat(64), observedAt: "2026-09-09", records: [], works: [{
    record: { id: "W-A", kind: "work", title: "Investigate launch", status: "proposed", path: "", parentId: null, spec: null, updatedAt: "2026-09-09", priority: 1 },
    managed: null, revision: "b".repeat(64), availability: "ready",
  }] };
  const pack = buildProjectBriefingPack({ db, projectId: "briefing-p", binding: "ledger-p", description: "Project description", snapshot,
    model: "openai/gpt-4o", language: "ko", contextTokens: 128000, reasoningEffort: "medium" });
  return { db, pack, snapshot };
}
function output(pack: ProjectBriefingPack): DashboardBriefingContent {
  return { introduction: "출시를 준비하는 프로젝트입니다.", position: { title: "진행 상황", body: "등록된 작업은 아직 시작되지 않았습니다.", sourceIds: [pack.sources[0]!.sourceId] },
    suggestions: pack.candidates.slice(0, 1).map((candidate) => ({ candidateId: candidate.id, title: "범위 확인", reason: "기록된 계획을 살펴볼 수 있습니다.", sourceIds: [candidate.sourceId] })) };
}
async function settle(predicate: () => boolean) {
  for (let index = 0; index < 100 && !predicate(); index++) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(predicate()).toBe(true);
}

test("source-linked user observations survive report selection and invalidate the derived briefing, not Work state", () => {
  const { db, snapshot } = fixture();
  const read = () => buildProjectBriefingPack({ db, projectId: "briefing-p", binding: "ledger-p", description: "P", snapshot,
    model: "openai/gpt-4o", language: "ko", contextTokens: 128000, reasoningEffort: "medium" });
  const ref = { type: "project_source_ref", projectId: "briefing-p", titleSnapshot: "Report", topic: "Long response delivery",
    source: { kind: "message", id: "report", revision: "d".repeat(64) } };
  const insert = (id: string, chat: string, role: string, text: string, parts: unknown, time: string) => db.query(
    "INSERT INTO messages(id,chat_id,role,text,status,content_parts_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
  ).run(id, chat, role, text, role === "user" ? "sent" : "delivered", JSON.stringify(parts), time, time);
  try {
    db.query("INSERT INTO chats(id,title,kind,project_id,created_at,updated_at) VALUES ('reports','Reports','project','briefing-p','2026-09-09','2026-09-09'), ('followup','Follow-up','project','briefing-p','2026-09-09','2026-09-09'), ('outside','Outside','chat',NULL,'2026-09-09','2026-09-09')").run();
    insert("report", "reports", "assistant", "Long response verification remains. OAuth verification is unrelated.", null, "2026-09-09T00:00:00Z");
    const before = read();
    insert("confirmation", "followup", "user", "@OAuth plan This feature works. You can mark it complete.",
      { version: 1, parts: [ref, { type: "text", text: "This feature works. You can mark it complete." }] }, "2026-09-09T01:00:00Z");
    // Unlinked claims and forged cross-project references cannot acquire a relation.
    insert("assistant-claim", "followup", "assistant", "I marked it done.", { version: 1, parts: [ref] }, "2026-09-09T01:01:00Z");
    insert("unlinked", "followup", "user", "Everything is complete.", null, "2026-09-09T01:02:00Z");
    insert("outside", "outside", "user", "Unrelated confirmation", { version: 1, parts: [ref] }, "2026-09-09T01:03:00Z");
    insert("wrong-project", "followup", "user", "Wrong project", { version: 1, parts: [{ ...ref, projectId: "other" }] }, "2026-09-09T01:04:00Z");
    const after = read();
    expect(after.revision).not.toBe(before.revision);
    const feedback = after.facts.find(fact => fact.sourceId === "message:report")!.linkedUserFollowups as Array<Record<string, unknown>>;
    expect(feedback).toHaveLength(1);
    expect(feedback[0]!.messageId).toBe("confirmation");
    expect(feedback[0]!.observation).toBe("This feature works. You can mark it complete.");
    expect(feedback[0]!.references).toEqual([{ revision: "d".repeat(64), topic: ref.topic }]);
    expect(after.facts.find(fact => fact.sourceId === "work:W-A")!.status).toBe("proposed");
    // Retain chronological newer contradictions, with bounded excerpts; no keyword status parser.
    for (let i = 2; i <= 5; i++) insert(`later-${i}`, "followup", "user", i === 5 ? "It now fails again." : "x".repeat(1300),
      { version: 1, parts: [ref] }, `2026-09-09T0${i}:00:00Z`);
    const latest = readProjectSourceFeedback(db, "briefing-p", "message:report");
    expect(latest.map(item => item.messageId)).toEqual(["later-3", "later-4", "later-5"]);
    expect(latest[0]!.observation).toHaveLength(1200);
    expect(latest[0]!.excerptTruncated).toBe(true);
    expect(latest[2]!.observation).toBe("It now fails again.");
    // The observation is retained by its source, not by a global latest-assistant-report window.
    expect(readProjectSourceFeedback(db, "briefing-p", "message:missing")).toEqual([]);
  } finally { db.close(); }
});

test("briefing schema rejects invented sources/candidates and extra authority fields", () => {
  const { db, pack } = fixture();
  try {
    expect(validateProjectBriefing(JSON.stringify(output(pack)), pack)).toEqual(output(pack));
    for (const invalid of [
      { ...output(pack), introduction: "x".repeat(181) },
      { ...output(pack), position: { ...output(pack).position, body: "x".repeat(241) } },
      { ...output(pack), position: { ...output(pack).position, title: "x".repeat(81) } },
      { ...output(pack), status: "completed" },
      { ...output(pack), position: { ...output(pack).position, sourceIds: ["other-project"] } },
      { ...output(pack), suggestions: [{ ...output(pack).suggestions[0], candidateId: "invented" }] },
      { ...output(pack), suggestions: [{ ...output(pack).suggestions[0], sourceIds: [] }] },
    ]) expect(() => validateProjectBriefing(JSON.stringify(invalid), pack)).toThrow();
  } finally { db.close(); }
});

test("automatic introduction is one-time and never overwrites a concurrent or explicitly empty edit", () => {
  const { db, pack } = fixture();
  try {
    expect(initializeProjectIntroduction(db, pack.projectId, 0, "Grounded introduction")).toBe(true);
    expect(initializeProjectIntroduction(db, pack.projectId, 0, "Overwrite")).toBe(false);
    db.query("UPDATE projects SET description = '', dashboard_preferences_revision = 2 WHERE id = ?").run(pack.projectId);
    expect(initializeProjectIntroduction(db, pack.projectId, 2, "Overwrite empty user edit")).toBe(false);
    db.query("UPDATE projects SET description = NULL, dashboard_preferences_revision = 3 WHERE id = ?").run(pack.projectId);
    expect(initializeProjectIntroduction(db, pack.projectId, 2, "Stale generation")).toBe(false);
  } finally { db.close(); }
});

test("GET does not run a model; slow concurrent POSTs share one call and stale generation cannot replace new facts", async () => {
  const { db, pack } = fixture();
  let current = pack; let calls = 0; let published = 0;
  let release: (value: DashboardBriefingContent) => void = () => {};
  const service = new ProjectBriefingStore({ db, butlerData: "/unused", readPack: async () => ({ pack: current, reasoningEffort: "medium" }),
    publish: () => { published++; }, generate: async () => { calls++; return await new Promise((resolve) => { release = resolve; }); } });
  try {
    expect((await service.read(pack.projectId)).status).toBe("needed"); expect(calls).toBe(0);
    expect((await service.request(pack.projectId, pack.revision, false)).status).toBe("generating");
    expect((await service.request(pack.projectId, pack.revision, false)).status).toBe("generating"); expect(calls).toBe(1);
    current = { ...pack, revision: "c".repeat(64) };
    release(output(pack)); await settle(() => published === 1);
    expect((await service.read(pack.projectId)).status).toBe("needed");
    expect(db.query("SELECT count(*) AS n FROM project_dashboard_briefing_cache").get()).toEqual({ n: 0 });
    await expect(service.request(pack.projectId, pack.revision, false)).rejects.toThrow("Source changed");
    await service.request(pack.projectId, current.revision, false); release(output(current));
    await settle(() => published === 2);
    expect((await service.read(pack.projectId)).status).toBe("ready");
    current = { ...current, revision: "d".repeat(64), language: "en" };
    expect((await service.read(pack.projectId)).status).toBe("needed");
  } finally { service.close(); db.close(); }
});

test("one generated answer initializes an untouched introduction and survives its own revision change", async () => {
  const { db, pack, snapshot } = fixture();
  let calls = 0; let published = 0;
  const readPack = async () => {
    const row = db.query<{ description: string | null }, [string]>("SELECT description FROM projects WHERE id = ?").get(pack.projectId)!;
    return { pack: buildProjectBriefingPack({ db, projectId: pack.projectId, binding: "ledger-p", description: row.description, snapshot,
      model: "openai/gpt-4o", language: "ko", contextTokens: 128000, reasoningEffort: "medium" }), reasoningEffort: "medium" as const };
  };
  const service = new ProjectBriefingStore({ db, butlerData: "/unused", readPack, publish: () => { published++; },
    generate: async ({ pack }) => { calls++; return output(pack); } });
  try {
    const before = await service.read(pack.projectId);
    await service.request(pack.projectId, before.sourceRevision, false);
    await settle(() => published === 1);
    const after = await service.read(pack.projectId);
    expect(after.status).toBe("ready");
    expect(after.sourceRevision).not.toBe(before.sourceRevision);
    expect(db.query("SELECT description, dashboard_preferences_revision FROM projects WHERE id = ?").get(pack.projectId))
      .toEqual({ description: output(pack).introduction, dashboard_preferences_revision: 1 });
    await service.request(pack.projectId, after.sourceRevision, false);
    expect(calls).toBe(1);
  } finally { service.close(); db.close(); }
});

test("failed model generation requires explicit retry; restart is not stuck generating and close aborts work", async () => {
  const { db, pack } = fixture(); let calls = 0; let published = 0; let aborted = false;
  const options = { db, butlerData: "/unused", readPack: async () => ({ pack, reasoningEffort: "medium" as const }), publish: () => { published++; } };
  const service = new ProjectBriefingStore({ ...options, generate: async () => { calls++; throw new Error("private provider details"); } });
  await service.request(pack.projectId, pack.revision, false); await settle(() => published === 1);
  expect((await service.read(pack.projectId)).status).toBe("unavailable");
  await service.request(pack.projectId, pack.revision, false); expect(calls).toBe(1);
  await service.request(pack.projectId, pack.revision, true); await settle(() => calls === 2);
  service.close();
  const restarted = new ProjectBriefingStore({ ...options, generate: async ({ signal }) => {
    await new Promise<void>((_resolve, reject) => { signal.addEventListener("abort", () => { aborted = true; reject(new Error("abort")); }); });
    return output(pack);
  } });
  try {
    expect((await restarted.read(pack.projectId)).status).toBe("needed");
    await restarted.request(pack.projectId, pack.revision, false); restarted.close();
    await settle(() => aborted);
  } finally { restarted.close(); db.close(); }
});

test("fact pack excludes whole over-budget units, unknown Work, and unsourced private payloads", () => {
  const { db, snapshot } = fixture();
  try {
    snapshot.works.push({ ...snapshot.works[0]!, availability: "unavailable", record: { ...snapshot.works[0]!.record, id: "missing" } });
    snapshot.works[0]!.record.title = "large unit ".repeat(8000);
    const pack = buildProjectBriefingPack({ db, projectId: "briefing-p", binding: "ledger-p", description: null, snapshot,
      model: "openai/gpt-4o", language: "ko", contextTokens: 4096, reasoningEffort: "medium" });
    expect(pack.coverage.totalWorks).toBe(2); expect(pack.coverage.includedWorks).toBe(0);
    expect(pack.sources).toEqual([]); expect(pack.candidates).toEqual([]); expect(pack.coverage.excludedUnits).toBe(2);
  } finally { db.close(); }
});

test("large Work history cannot starve recent public reports or document metadata", () => {
  const { db, snapshot } = fixture();
  try {
    snapshot.works = Array.from({ length: 30 }, (_, index) => ({ ...snapshot.works[0]!,
      record: { ...snapshot.works[0]!.record, id: `W-${index}`, title: `Work ${index} ${"bounded context ".repeat(160)}` } }));
    snapshot.records = [{ ...snapshot.works[0]!.record, id: "SPEC", kind: "spec", title: "Project direction" }];
    db.query("INSERT INTO chats(id,title,kind,project_id,created_at,updated_at) VALUES ('reports','Reports','project','briefing-p','2026-09-09','2026-09-09')").run();
    db.query("INSERT INTO messages(id,chat_id,role,text,status,created_at,updated_at) VALUES ('report','reports','assistant','Latest public report, verification still needed.','delivered','2026-09-09','2026-09-09')").run();
    const pack = buildProjectBriefingPack({ db, projectId: "briefing-p", binding: "ledger-p", description: null, snapshot,
      model: "openai/gpt-4o", language: "ko", contextTokens: 128000, reasoningEffort: "medium" });
    expect(pack.coverage.includedWorks).toBeGreaterThan(0);
    expect(pack.coverage.includedDocuments).toBe(1);
    expect(pack.coverage.includedReports).toBe(1);
    expect(pack.sources.some((source) => source.id === "report")).toBe(true);
  } finally { db.close(); }
});
