import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateAppStoreSchema } from "../../packages/butler-agent/src/gateways/app/infrastructure/core/schema.ts";
import { compareHistory, projectPublicHistory } from "../../packages/butler-agent/src/gateways/app/domain/projects/project-public-history.ts";
import type { DashboardHistoryPage } from "../../packages/butler-agent/src/gateways/app/interface/protocol/session-dashboard-contract.ts";

test("merged history has stable timestamp/id pagination and excludes other projects and private messages", () => {
  const db = new Database(":memory:"); migrateAppStoreSchema(db);
  const stamp = "2026-09-09T00:00:00.000Z";
  const add = (id: string, project = "p", role = "assistant", status = "delivered") => {
    db.query("INSERT INTO chats(id,title,kind,project_id,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(id, id, "project", project, stamp, stamp);
    db.query("INSERT INTO messages(id,chat_id,role,text,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(id, id, role, "Public text", status, stamp, stamp);
  };
  try {
    add("a"); add("c"); add("b"); add("other", "other"); add("input", "p", "user", "sent"); add("pending", "p", "assistant", "streaming");
    const ledger = ["z", "a"].map((id) => ({ id: `ledger:${id}`, at: stamp, action: "updated" as const,
      title: id, source: { kind: "work", id, revision: "a".repeat(64) } })).sort(compareHistory);
    let page = projectPublicHistory(db, "p", "r1", ledger, { limit: 2 }, false);
    if (page.status !== "ready") throw new Error("unavailable");
    const ids = page.events.map((event) => event.id);
    const cursor = page.nextCursor!;
    add("inserted-after-page");
    expect(() => projectPublicHistory(db, "other", "r1", ledger, { cursor, limit: 2 }, false)).toThrow("Invalid cursor");
    expect(() => projectPublicHistory(db, "p", "r2", ledger, { cursor, limit: 2 }, false)).toThrow("Reload the history");
    while (page.nextCursor) {
      const next = projectPublicHistory(db, "p", "r1", ledger, { cursor: page.nextCursor, limit: 2 }, false);
      if (next.status !== "ready") throw new Error("unavailable");
      page = next; ids.push(...page.events.map((event) => event.id));
    }
    expect(ids).toEqual(["message:c", "message:b", "message:a", "ledger:z", "ledger:a"]);
    const missing = projectPublicHistory(db, "p", "unavailable", [], { limit: 50 }, true) as Extract<DashboardHistoryPage, { status: "ready" }>;
    expect(missing.ledgerUnavailable).toBe(true);
    expect(missing.events).toHaveLength(4);
    expect(missing.events.every((event) => event.session?.id && event.source.kind === "message")).toBe(true);
  } finally { db.close(); }
});

test("Work timeline selects its own period and event kinds before the page limit", () => {
  const db = new Database(":memory:"); migrateAppStoreSchema(db);
  const at = "2026-09-09T00:00:00.000Z";
  try {
    db.query("INSERT INTO chats(id,title,kind,project_id,created_at,updated_at) VALUES ('c','c','project','p',?,?)").run(at, at);
    for (let i = 0; i < 150; i++) db.query("INSERT INTO messages(id,chat_id,role,text,status,created_at,updated_at) VALUES (?,'c','assistant','report','delivered',?,?)").run(`m${i}`, at, at);
    const events = Array.from({ length: 150 }, (_, i) => ({ id: `result:${i}`, at, action: "result" as const,
      workId: "w", title: "Result", source: { kind: "reference", id: `result:${i}`, revision: "r" } }));
    const ledger = [...events, ...["2026-09-07", "2026-09-06", "2026-08-01"].map((date) => ({
      id: date, at: `${date}T00:00:00.000Z`, action: "updated" as const,
      title: "Work", source: { kind: "work", id: "w", revision: "r" },
    }))].sort(compareHistory);
    const query = { limit: 1, workRange: { from: "2026-09-01T00:00:00.000Z", to: "2026-09-10T00:00:00.000Z" } };
    const first = projectPublicHistory(db, "p", "r", ledger, query, false);
    if (first.status !== "ready") throw new Error("unavailable");
    expect(first.events.map((e) => e.id)).toEqual(["2026-09-07"]);
    expect(first.nextCursor).toBeString();
    const second = projectPublicHistory(db, "p", "r", ledger, { ...query, cursor: first.nextCursor! }, false);
    expect(second.status === "ready" && second.events.map((e) => e.id)).toEqual(["2026-09-06"]);
    expect(second.status === "ready" && second.nextCursor).toBeNull();
    expect(() => projectPublicHistory(db, "p", "r", ledger, { limit: 1, cursor: first.nextCursor! }, false)).toThrow("Reload the history");
  } finally { db.close(); }
});
