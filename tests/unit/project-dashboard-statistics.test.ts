import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateAppStoreSchema } from "../../packages/butler-agent/src/gateways/app/infrastructure/core/schema.ts";
import { projectDayRanges, projectStatistics } from "../../packages/butler-agent/src/gateways/app/domain/projects/project-statistics.ts";
import { eventTurnMatchSql } from "../../packages/butler-agent/src/gateways/app/infrastructure/events/event-turn-query.ts";
import type { DashboardLedgerSnapshot } from "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/index.ts";
import { createProjectDashboardHistoryReader } from "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/index.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("calendar boundaries honor spring/fall DST, half-hour shifts, midnight gaps and skipped calendar dates", () => {
  const day = (zone: string, date: string, now: string) => projectDayRanges(zone, 7, new Date(now)).find((item) => item.date === date)!;
  const hours = (range: { start: string; end: string }) => (Date.parse(range.end) - Date.parse(range.start)) / 3600000;
  expect(hours(day("America/New_York", "2026-03-08", "2026-03-10T12:00:00Z"))).toBe(23);
  expect(hours(day("America/New_York", "2026-11-01", "2026-11-03T12:00:00Z"))).toBe(25);
  expect(hours(day("Australia/Lord_Howe", "2026-10-04", "2026-10-06T12:00:00Z"))).toBe(23.5);
  expect(hours(day("America/Sao_Paulo", "2018-11-04", "2018-11-06T12:00:00Z"))).toBe(23);
  expect(hours(day("Pacific/Apia", "2011-12-30", "2012-01-01T00:00:00Z"))).toBe(0);
  const seoul = day("Asia/Seoul", "2026-09-09", "2026-09-09T03:12:00Z");
  expect(seoul.start).toBe("2026-09-08T15:00:00.000Z"); expect(seoul.end).toBe("2026-09-09T03:12:00.000Z"); expect(seoul.partial).toBe(true);
  expect(() => projectDayRanges("Not/A_Zone", 7, new Date())).toThrow("Invalid timezone");
});

test("activity returns scoped source locators per local day, not message productivity counts", () => {
  const db = new Database(":memory:"); migrateAppStoreSchema(db);
  const now = new Date("2026-09-09T03:00:00.000Z");
  try {
    for (const [id, project, archived] of [["stats-a", "p", 0], ["stats-b", "p", 1], ["stats-c", "other", 0]] as const) {
      db.query("INSERT INTO chats(id,title,kind,project_id,archived,created_at,updated_at) VALUES (?,?,'project',?,?,?,?)").run(id, id, project, archived, now.toISOString(), now.toISOString());
    }
    const insert = (id: string, chat: string, role: string, at: string) => db.query("INSERT INTO messages(id,chat_id,role,text,status,created_at,updated_at) VALUES (?,?,?,'hello','delivered',?,?)").run(id, chat, role, at, at);
    insert("before", "stats-a", "user", "2026-09-08T14:59:59.999Z");
    insert("boundary", "stats-a", "user", "2026-09-08T15:00:00.000Z");
    insert("same", "stats-a", "user", "2026-09-08T16:00:00.000Z");
    insert("archived", "stats-b", "user", "2026-09-08T16:00:00.000Z");
    insert("assistant", "stats-a", "assistant", "2026-09-08T16:00:00.000Z");
    insert("system", "stats-a", "system", "2026-09-08T16:00:00.000Z");
    insert("other", "stats-c", "user", "2026-09-08T16:00:00.000Z");
    insert("future", "stats-a", "user", now.toISOString());
    const data = projectStatistics(db, "p", 7, "Asia/Seoul", null, now);
    expect(data.activity.buckets.at(-1)!.values.conversations).toEqual(["session:stats-a:2026-09-09", "session:stats-b:2026-09-09"]);
    expect(data.activity.buckets.at(-2)!.values.conversations).toEqual(["session:stats-a:2026-09-08"]);
    expect(data.activity.buckets[0]!.values.conversations).toEqual([]);
    expect(Object.keys(data.sources).some((key) => key.startsWith("session:stats-c:"))).toBe(false);
    expect(data.work).toBeNull();
    expect(data.ledgerHistoryAvailable).toBe(false);
    expect(data.usage.status).toBe("unavailable");
    expect(JSON.stringify(data)).not.toContain("userMessages");
    db.query("DELETE FROM messages WHERE id='archived'").run();
    expect(projectStatistics(db, "p", 7, "Asia/Seoul", null, now).activity.buckets.at(-1)!.values.conversations).toHaveLength(1);
  } finally { db.close(); }
});

test("an incomplete session read discards partial counts without hiding available Ledger history", () => {
  const db = new Database(":memory:"); migrateAppStoreSchema(db);
  const at = "2026-09-09T01:00:00.000Z";
  const record = { id: "S", kind: "spec", title: "Available specification", status: "active", path: "", parentId: null, spec: null, updatedAt: at, priority: 0 };
  const snapshot = { revision: "r", observedAt: at, records: [record], works: [] } as unknown as DashboardLedgerSnapshot;
  try {
    db.query("INSERT INTO chats(id,title,kind,project_id,archived,created_at,updated_at) VALUES ('s','Conversation','project','p',0,?,?)").run(at, at);
    db.query("INSERT INTO messages(id,chat_id,role,text,status,created_at,updated_at) VALUES ('m','s','user','hello','sent',?,?)").run(at, at);
    db.query("INSERT INTO turns(id,chat_id,state,safe_status_label,created_at,updated_at) VALUES ('missing-event','s','delivered','',?,?)").run(at, at);
    db.exec("DROP TABLE events"); // Fail after the conversation and attachment queries have run.
    const view = projectStatistics(db, "p", 7, "UTC", { snapshot, history: { managed: [],
      ledger: [{ id: "e", recordId: "S", kind: "spec", action: "created", at }] } }, new Date("2026-09-09T12:00:00Z"));
    expect(view.sessionHistoryAvailable).toBe(false);
    expect(view.ledgerHistoryAvailable).toBe(true);
    expect(view.activity.keys).toEqual(["work", "materials"]);
    expect(view.activity.buckets.flatMap((day) => day.values.conversations!)).toEqual([]);
    expect(Object.keys(view.sources)).toEqual(["spec:S"]);
    expect(view.materialTypes.keys).toEqual(["spec", "plan", "report"]);
    expect(view.materialTypes.buckets.at(-1)!.values.spec).toEqual(["spec:S"]);
  } finally { db.close(); }
});

test("whole period exceeds 100 events, deduplicates completion and separates managed dispositions from review", () => {
  const db = new Database(":memory:"); migrateAppStoreSchema(db);
  const now = new Date("2026-09-09T12:00:00Z");
  const at = "2026-09-08T01:00:00Z";
  const record = (id: string, kind = "work", status = "done") => ({ id, kind, title: id, status, path: "", parentId: null, spec: null, updatedAt: at, priority: 0 });
  const records = Array.from({ length: 125 }, (_, index) => record(`W-${index}`));
  records.push(record("W-managed", "work", "review"), record("W-blocked", "work", "blocked"), record("T", "task"), record("S", "spec", "active"));
  const snapshot = { revision: "r", observedAt: at, records, works: records.filter((record) => record.kind === "work").map((record) => ({ record,
    availability: "ready", revision: "r", managed: record.id === "W-managed" ? { status: "completed", objective: "Managed objective" } : null })) } as unknown as DashboardLedgerSnapshot;
  const ledger = records.map((record) => ({ id: `event-${record.id}`, recordId: record.id, kind: record.kind, action: record.id === "S" ? "updated" : "completed", at }));
  ledger.push({ ...ledger[0]!, id: "duplicate", at: "2026-09-09T01:00:00Z" });
  const managed = ["passed", "completed", "blocked"].map((status, index) => ({ id: `m-${index}`, workId: "W-managed", sessionId: "s",
    at, action: status === "passed" ? "reviewed" as const : "disposition" as const, status, title: "Managed objective", body: "private", revision: "r" }));
  try {
    const data = projectStatistics(db, "p", 7, "UTC", { snapshot, history: { ledger, managed } }, now);
    const refs = data.work!.work.buckets.flatMap((bucket) => bucket.values.completed!);
    expect(refs).toHaveLength(126); // 125 + blocked head's historical completion, not managed review.
    expect(new Set(refs).size).toBe(126);
    expect(data.work!.work.buckets.flatMap((bucket) => bucket.values.executed!)).toEqual(["work:W-managed"]);
    // A synthetic completion event cannot make the canonical Task history complete.
    expect(data.work!.task.keys).toEqual(["created"]);
    expect(data.work!.task.buckets.every((bucket) => bucket.values.completed === undefined)).toBe(true);
    expect(data.work!.cards.work.find((card) => card.id === "W-blocked")!.lane).toBe("blocked");
    expect(data.work!.cards.work.find((card) => card.id === "W-managed")!.lane).toBe("done");
    expect(data.materials.buckets.flatMap((bucket) => bucket.values.updated!)).toEqual(["spec:S"]);
    expect(data.materialTypes.buckets.flatMap((bucket) => bucket.values.spec!)).toEqual(["spec:S"]);
    for (const series of [data.work!.work, data.work!.task, data.materials, data.materialTypes, data.activity]) {
      for (const bucket of series.buckets) for (const ref of Object.values(bucket.values).flat()) expect(data.sources[ref]).toBeDefined();
    }
    expect(JSON.stringify(data)).not.toContain("private");
    const unavailable = projectStatistics(db, "p", 7, "UTC", { snapshot, history: null }, now);
    expect(unavailable.work!.cards.work).toHaveLength(127);
    expect(unavailable.ledgerHistoryAvailable).toBe(false);
  } finally { db.close(); }
});

for (const layout of ["column", "legacy"] as const) test(`request timing supports ${layout} identity layout and exact terminal events`, () => {
  const db = new Database(":memory:"); migrateAppStoreSchema(db);
  if (layout === "legacy") db.exec("DROP INDEX events_turn_id_idx; CREATE INDEX events_type_turn_id_idx ON events(type, json_extract(payload_json, '$.turn_id'), id DESC)");
  const plan = db.query(`EXPLAIN QUERY PLAN SELECT id FROM events WHERE type='turn.state_changed' AND ${eventTurnMatchSql(db)} ORDER BY id DESC LIMIT 1`).all("done");
  expect(JSON.stringify(plan)).toContain(layout === "column" ? "events_turn_id_idx" : "events_type_turn_id_idx");
  const now = new Date("2026-09-09T12:00:00Z");
  const started = "2026-09-09T01:00:00.000Z";
  const ended = "2026-09-09T01:01:00.000Z";
  try {
    for (const [id, project] of [["s", "p"], ["other", "other"]]) db.query("INSERT INTO chats(id,title,kind,project_id,created_at,updated_at) VALUES (?,?,'project',?,?,?)").run(id!, id!, project!, started, ended);
    for (const [id, chat, state, event] of [["done", "s", "delivered", true], ["fault", "s", "runtime_fault", true], ["missing", "s", "delivered", false], ["other", "other", "delivered", true]] as const) {
      db.query("INSERT INTO turns(id,chat_id,state,safe_status_label,created_at,updated_at) VALUES (?,?,?,'',?,?)").run(id, chat, state, started, now.toISOString());
      if (event) db.query("INSERT INTO events(type,turn_id,payload_json,created_at) VALUES ('turn.state_changed',?,?,?)").run(layout === "column" ? id : "", JSON.stringify({ turn: { id, state, updated_at: ended } }), ended);
    }
    const data = projectStatistics(db, "p", 7, "UTC", null, now);
    expect(data.sources["turn:done"]!.durationMs).toBe(60000);
    expect(data.sources["turn:other"]).toBeUndefined();
    expect(data.sources["turn:missing"]).toBeUndefined();
    expect(data.execution.excluded).toBe(1);
    expect(data.execution.duration.buckets[1]!.values.delivered).toEqual(["turn:done"]);
    expect(data.execution.duration.buckets[1]!.values.failed).toEqual(["turn:fault"]);
  } finally { db.close(); }
});

test("published attachments are unique materials; user uploads and other projects are not results", () => {
  const db = new Database(":memory:"); migrateAppStoreSchema(db);
  const stamp = "2026-09-08T01:00:00.000Z";
  try {
    db.query("INSERT INTO chats(id,title,kind,project_id,created_at,updated_at) VALUES ('s','s','project','p',?,?)").run(stamp, stamp);
    for (const [id, role] of [["a", "assistant"], ["b", "assistant"], ["u", "user"]]) {
      db.query("INSERT INTO messages(id,chat_id,role,text,status,created_at,updated_at) VALUES (?,'s',?,'','delivered',?,?)").run(id!, role!, stamp, stamp);
    }
    for (const id of ["file-output", "file-upload"]) db.query("INSERT INTO message_files(id,kind,mime_type,safe_name,size_bytes,sha256,storage_name,created_at) VALUES (?,'file','text/plain','document',1,'sha','private-path',?)").run(id, stamp);
    for (const [message, file] of [["a", "file-output"], ["b", "file-output"], ["u", "file-upload"]]) db.query("INSERT INTO message_attachments(message_id,file_id,position) VALUES (?,?,0)").run(message!, file!);
    const data = projectStatistics(db, "p", 7, "UTC", null, new Date("2026-09-09T12:00:00Z"));
    expect(data.materials.buckets.flatMap((bucket) => bucket.values.artifacts!)).toEqual(["artifact:file-output"]);
    expect(data.sources["artifact:file-output"]!.source!.id).toBe("artifact-file-output");
    expect(JSON.stringify(data)).not.toContain("private-path");
    expect(projectStatistics(db, "other", 7, "UTC", null, new Date("2026-09-09T12:00:00Z")).materials.buckets.flatMap((bucket) => bucket.values.artifacts!)).toEqual([]);
  } finally { db.close(); }
});

test("full history reader exceeds UI page size and refuses a damaged log rather than returning a partial total", () => {
  const root = mkdtempSync(join(tmpdir(), "statistics-history-"));
  const read = createProjectDashboardHistoryReader();
  const history = Array.from({ length: 130 }, (_, index) => JSON.stringify({ type: "work_created", id: `W-${index}`, ts: "2026-09-08T00:00:00Z" })).join("\n") + "\n";
  try {
    writeFileSync(join(root, "ledger.jsonl"), history);
    expect(read(root).events).toHaveLength(130);
    writeFileSync(join(root, "ledger.jsonl"), `${history}{damaged\n`);
    expect(() => read(root)).toThrow("dashboard_history_incomplete");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
