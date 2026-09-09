import type { Database } from "bun:sqlite";
import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";
import { visibleMessageSqlPredicate } from "../sessions/visible-message-sql.ts";

export interface ProjectActivityStatistics {
  timezone: string; period: 7 | 30 | 90; observedAt: string;
  days: Array<{ date: string; start: string; end: string; partial: boolean; userMessages: number; activeConversations: number }>;
}

/** Calendar labels are advanced as dates; UTC boundaries are independently resolved in the IANA zone. */
export function projectDayRanges(timezone: string, period: 7 | 30 | 90, now: Date) {
  if (typeof timezone !== "string" || !timezone || timezone.length > 100 || ![7, 30, 90].includes(period) || !Number.isFinite(now.getTime())) {
    throw new AppStoreOperationError(400, "invalid_statistics_query", "Invalid statistics query.");
  }
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", calendar: "gregory", numberingSystem: "latn" }); }
  catch { throw new AppStoreOperationError(400, "invalid_timezone", "Invalid timezone."); }
  const dateAt = (ms: number) => {
    const parts = formatter.formatToParts(ms);
    return ["year", "month", "day"].map((type) => parts.find((part) => part.type === type)!.value).join("-");
  };
  const today = dateAt(now.getTime());
  const calendarDate = (offset: number) => {
    const day = new Date(`${today}T00:00:00.000Z`); day.setUTCDate(day.getUTCDate() + offset);
    return day.toISOString().slice(0, 10);
  };
  const boundary = (date: string) => {
    const nominal = Date.parse(`${date}T00:00:00.000Z`);
    let lo = nominal - 36 * 3600000, hi = nominal + 36 * 3600000;
    // Includes midnight transitions and skipped dates (whose start equals the next date's start).
    while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (dateAt(mid) < date) lo = mid + 1; else hi = mid; }
    return lo;
  };
  const labels = Array.from({ length: period + 1 }, (_, index) => calendarDate(index - period + 1));
  const boundaries = labels.map(boundary);
  return labels.slice(0, -1).map((date, index) => ({ date, start: new Date(boundaries[index]!).toISOString(),
    end: new Date(Math.min(boundaries[index + 1]!, now.getTime())).toISOString(), partial: date === today }));
}

export function readProjectActivityStatistics(db: Database, projectId: string, period: 7 | 30 | 90, timezone: string, now = new Date()): ProjectActivityStatistics {
  const ranges = projectDayRanges(timezone, period, now);
  const query = db.query<{ messages: number; conversations: number }, [string, string, string]>(`
    SELECT COUNT(*) AS messages, COUNT(DISTINCT m.chat_id) AS conversations
    FROM chats c JOIN messages m ON m.chat_id = c.id
    WHERE c.project_id = ? AND m.role = 'user' AND m.created_at >= ? AND m.created_at < ?
      AND ${visibleMessageSqlPredicate("m")}
  `);
  const days = db.transaction(() => ranges.map((range) => {
    const counts = query.get(projectId, range.start, range.end)!;
    return { ...range, userMessages: counts.messages, activeConversations: counts.conversations };
  }))();
  return { timezone, period, observedAt: now.toISOString(), days };
}
