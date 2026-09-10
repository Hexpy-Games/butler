import type { Database } from "bun:sqlite";
import type { DashboardStatisticsView } from "../../interface/protocol/session-dashboard-contract.ts";
import { visibleMessageSqlPredicate } from "../sessions/visible-message-sql.ts";
import { sanitizePublicText } from "../../../../agent/events/public-text.ts";
import { addStatistic, statisticDay } from "./project-statistics-ledger.ts";
import { eventTurnMatchSql } from "../../infrastructure/events/event-turn-query.ts";

const MAX_STATISTIC_ROWS = 20_000;
function bounded<T>(rows: T[]): T[] {
  if (rows.length > MAX_STATISTIC_ROWS) throw new Error("project_statistics_limit");
  return rows;
}

/** Public locators and timing metadata only, never message or event bodies. */
export function populateSessionStatistics(db: Database, projectId: string, view: DashboardStatisticsView) {
  const from = view.days[0]!.start;
  const to = view.observedAt;
  const conversations = db.query<{ id: string; title: string; at: string }, [string, string, string, number]>(`
    SELECT c.id,c.title,max(m.created_at) AS at FROM chats c JOIN messages m ON m.chat_id=c.id
    WHERE c.project_id=? AND m.created_at>=? AND m.created_at<? AND m.role IN ('user','assistant')
      AND m.status IN ('sent','delivered') AND ${visibleMessageSqlPredicate("m")}
    GROUP BY c.id ORDER BY c.id LIMIT ?
  `);
  for (const [index, day] of view.days.entries()) {
    for (const row of bounded(conversations.all(projectId, day.start, day.end, MAX_STATISTIC_ROWS + 1))) {
      const key = `session:${row.id}:${day.date}`;
      const title = sanitizePublicText(row.title, "");
      view.sources[key] = { title, at: row.at, session: { id: row.id, title } };
      addStatistic(view.activity, index, "conversations", key);
    }
  }
  const artifacts = bounded(db.query<{ id: string; title: string; revision: string; at: string; session_id: string; session_title: string },
    [string, string, string, number]>(`
    SELECT f.id,f.safe_name AS title,f.sha256 AS revision,min(m.created_at) AS at,c.id AS session_id,c.title AS session_title
    FROM chats c JOIN messages m ON m.chat_id=c.id JOIN message_attachments a ON a.message_id=m.id
    JOIN message_files f ON f.id=a.file_id
    WHERE c.project_id=? AND m.role='assistant' AND m.status='delivered' AND ${visibleMessageSqlPredicate("m")}
    GROUP BY f.id HAVING at>=? AND at<? ORDER BY at,f.id LIMIT ?
  `).all(projectId, from, to, MAX_STATISTIC_ROWS + 1));
  for (const row of artifacts) {
    const key = `artifact:${row.id}`;
    view.sources[key] = { title: sanitizePublicText(row.title, ""), at: row.at,
      source: { id: `artifact-${row.id}`, kind: "artifact", revision: row.revision },
      session: { id: row.session_id, title: sanitizePublicText(row.session_title, "") } };
    const day = statisticDay(view, row.at);
    addStatistic(view.materials, day, "artifacts", key);
    addStatistic(view.materialTypes, day, "artifacts", key);
    addStatistic(view.activity, day, "materials", key);
  }
  const turns = bounded(db.query<{ id: string; chat_id: string; title: string; state: string; created_at: string },
    [string, string, number]>(`
    SELECT t.id,t.chat_id,c.title,t.state,t.created_at
    FROM chats c JOIN turns t ON t.chat_id=c.id
    WHERE c.project_id=? AND t.updated_at>=? AND t.state IN ('delivered','failed','cancelled','runtime_fault')
    ORDER BY t.id LIMIT ?
  `).all(projectId, from, MAX_STATISTIC_ROWS + 1));
  const terminalTimes = latestTerminalTimes(db, turns);
  for (const row of turns) {
    const terminalAt = terminalTimes.get(row.id);
    if (!terminalAt || !Number.isFinite(Date.parse(terminalAt))) { view.execution.excluded++; continue; }
    const day = statisticDay(view, terminalAt);
    if (day < 0) continue;
    const key = `turn:${row.id}`;
    const title = sanitizePublicText(row.title, "");
    const duration = Date.parse(terminalAt) - Date.parse(row.created_at);
    view.sources[key] = { title, at: terminalAt, session: { id: row.chat_id, title },
      ...(Number.isFinite(duration) && duration >= 0 ? { durationMs: duration } : {}) };
    const outcome = row.state === "delivered" ? "delivered" : row.state === "cancelled" ? "cancelled" : "failed";
    addStatistic(view.execution.outcomes, day, outcome, key);
    if (view.sources[key]!.durationMs === undefined) { view.execution.excluded++; continue; }
    const bucket = duration < 30_000 ? 0 : duration < 120_000 ? 1 : duration < 600_000 ? 2 : 3;
    addStatistic(view.execution.duration, bucket, outcome, key);
  }
}

/** Existing databases intentionally retain their old indexes. Never do a
 * project-wide event scan once per Turn, or assume old rows have column IDs. */
function latestTerminalTimes(db: Database, turns: Array<{ id: string; state: string }>) {
  const times = new Map<string, string>();
  if (!turns.length) return times;
  const indexed = db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='events_turn_id_idx'").get();
  if (indexed) {
    const terminal = db.query<{ at: string }, [string, string]>(`
      SELECT json_extract(payload_json,'$.turn.updated_at') AS at FROM events
      WHERE type='turn.state_changed' AND ${eventTurnMatchSql(db)} AND json_valid(payload_json)
        AND json_extract(payload_json,'$.turn.state')=? ORDER BY id DESC LIMIT 1
    `);
    for (const turn of turns) {
      const row = terminal.get(turn.id, turn.state);
      if (row) times.set(turn.id, row.at);
    }
    return times;
  }
  const pending = new Map(turns.map((turn) => [turn.id, turn.state]));
  const events = db.query<{ turn_id: string; state: string; at: string }, []>(`
    SELECT COALESCE(NULLIF(turn_id,''), json_extract(payload_json,'$.turn_id'), json_extract(payload_json,'$.turn.id')) AS turn_id,
      json_extract(payload_json,'$.turn.state') AS state, json_extract(payload_json,'$.turn.updated_at') AS at
    FROM events WHERE type='turn.state_changed' AND json_valid(payload_json) ORDER BY id DESC
  `);
  for (const event of events.iterate()) {
    if (!pending.has(event.turn_id) || pending.get(event.turn_id) !== event.state) continue;
    times.set(event.turn_id, event.at);
    pending.delete(event.turn_id);
    if (!pending.size) break;
  }
  return times;
}
