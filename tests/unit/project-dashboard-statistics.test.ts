import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateAppStoreSchema } from "../../packages/butler-agent/src/gateways/app/infrastructure/core/schema.ts";
import { projectDayRanges, readProjectActivityStatistics } from "../../packages/butler-agent/src/gateways/app/domain/projects/project-statistics.ts";

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

test("statistics count only user-role records in the selected project's local [start,end) days, including archived conversations", () => {
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
    const data = readProjectActivityStatistics(db, "p", 7, "Asia/Seoul", now);
    expect(data.days.at(-1)).toMatchObject({ userMessages: 3, activeConversations: 2, partial: true });
    expect(data.days.at(-2)).toMatchObject({ userMessages: 1, activeConversations: 1, partial: false });
    expect(data.days[0]).toMatchObject({ userMessages: 0, activeConversations: 0 });
    db.query("DELETE FROM messages WHERE id='archived'").run();
    expect(readProjectActivityStatistics(db, "p", 7, "Asia/Seoul", now).days.at(-1)?.activeConversations).toBe(1);
  } finally { db.close(); }
});
