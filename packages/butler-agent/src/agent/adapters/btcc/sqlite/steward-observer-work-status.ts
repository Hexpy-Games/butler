import type { Database } from "bun:sqlite";
import type {
  WorkStatusItemView,
  WorkStatusState,
  WorkStatusView,
} from "../../../../gateways/app/interface/protocol/app-protocol.ts";

type WorkStatusRow = {
  work_id: string;
  session_id: string;
  work_status: string;
  work_updated_at: string;
  turn_id: string | null;
  turn_state: string | null;
  safe_title: string | null;
  disposition: string | null;
  runtime_owned_open: number | null;
  disposition_created_at: string | null;
  stage: WorkStatusItemView["stage"] | null;
  public_summary: string | null;
  action_states_json: string | null;
  checkpoint_created_at: string | null;
  unresolved_blockers: number;
  effect_count: number;
};

type OperationalNotice = {
  status: "recovering" | "interrupted" | "cleared";
  summary: string;
  createdAt: string;
};

const CANDIDATE_LIMIT = 24;
const ITEM_LIMIT = 8;

export function readWorkStatus(db: Database): WorkStatusView {
  const rows = db.query<WorkStatusRow, [number]>(`
    SELECT work.work_id, work.session_id, work.status AS work_status,
      work.updated_at AS work_updated_at,
      turn.turn_id, turn.semantic_state AS turn_state,
      relation.safe_title,
      disposition.disposition, disposition.runtime_owned_open,
      disposition.created_at AS disposition_created_at,
      checkpoint.stage, checkpoint.public_summary,
      checkpoint.action_states_json,
      checkpoint.created_at AS checkpoint_created_at,
      (SELECT COUNT(*) FROM btcc_guided_work_effect_blockers AS blocker
        WHERE blocker.work_id = work.work_id AND blocker.status = 'unresolved'
      ) AS unresolved_blockers,
      (SELECT COUNT(*) FROM btcc_guided_effects AS effect
        WHERE effect.work_id = work.work_id
      ) AS effect_count
    FROM btcc_guided_works AS work
    LEFT JOIN btcc_guided_turn_work_bindings AS binding
      ON binding.rowid = (
        SELECT candidate.rowid FROM btcc_guided_turn_work_bindings AS candidate
        WHERE candidate.work_id = work.work_id
        ORDER BY candidate.bound_at DESC, candidate.rowid DESC LIMIT 1
      )
    LEFT JOIN btcc_turns AS turn ON turn.turn_id = binding.turn_id
    LEFT JOIN btcc_session_relations AS relation
      ON relation.child_session_id = work.session_id
    LEFT JOIN btcc_guided_work_disposition_revisions AS disposition
      ON disposition.work_id = work.work_id
     AND disposition.revision = (
        SELECT MAX(candidate.revision)
        FROM btcc_guided_work_disposition_revisions AS candidate
        WHERE candidate.work_id = work.work_id
     )
    LEFT JOIN btcc_guided_work_checkpoint_revisions AS checkpoint
      ON checkpoint.work_id = work.work_id
     AND checkpoint.revision = (
        SELECT MAX(candidate.revision)
        FROM btcc_guided_work_checkpoint_revisions AS candidate
        WHERE candidate.work_id = work.work_id
     )
    WHERE work.status != 'abandoned'
    ORDER BY CASE WHEN work.status IN ('open', 'blocked') THEN 0 ELSE 1 END,
      work.updated_at DESC
    LIMIT ?
  `).all(CANDIDATE_LIMIT);
  const items = rows.map((row) => projectWorkStatus(db, row))
    .sort((left, right) =>
      statePriority(left.state) - statePriority(right.state) ||
      right.updated_at.localeCompare(left.updated_at),
    )
    .slice(0, ITEM_LIMIT);
  return { items, counts: countStates(items) };
}

function projectWorkStatus(db: Database, row: WorkStatusRow): WorkStatusItemView {
  const notice = latestOperationalNotice(db, row.work_id);
  const actions = actionCounts(row.action_states_json);
  const summary = notice?.status === "recovering" || notice?.status === "interrupted"
    ? notice.summary
    : row.public_summary ?? "Work status is available.";
  return {
    session_id: row.session_id,
    safe_title: safeText(row.safe_title, "Butler work", row),
    safe_summary: safeText(summary, "Work status is available.", row),
    state: classifyState(row, notice),
    ...(row.stage ? { stage: row.stage } : {}),
    completed_actions: actions.completed,
    total_actions: actions.total,
    effect_count: Math.max(0, row.effect_count),
    updated_at: latestTimestamp([
      row.work_updated_at,
      row.disposition_created_at ?? "",
      row.checkpoint_created_at ?? "",
      notice?.createdAt ?? "",
    ].filter(Boolean)),
  };
}

function latestOperationalNotice(db: Database, workId: string): OperationalNotice | null {
  const rows = db.query<{ event_json: string; created_at: string }, [string]>(`
    SELECT progress.event_json, progress.created_at
    FROM btcc_progress_events AS progress
    JOIN btcc_guided_turn_work_bindings AS binding
      ON binding.turn_id = progress.turn_id
    WHERE binding.work_id = ?
    ORDER BY progress.session_sequence DESC, progress.event_id DESC
    LIMIT 32
  `).all(workId);
  for (const row of rows) {
    try {
      const event = JSON.parse(row.event_json) as Record<string, unknown>;
      const payload = isRecord(event.payload) ? event.payload : {};
      if (event.kind !== "assistant.public_note" || event.visibility !== "public" ||
        payload.bridgePhase !== "operational_recovery") continue;
      const status = payload.recoveryStatus;
      if (status !== "recovering" && status !== "interrupted" && status !== "cleared") continue;
      return {
        status,
        summary: typeof payload.note === "string" ? payload.note : "Operational status changed.",
        createdAt: row.created_at,
      };
    } catch {
      continue;
    }
  }
  return null;
}

function classifyState(row: WorkStatusRow, notice: OperationalNotice | null): WorkStatusState {
  if (notice?.status === "interrupted") return "operational_interruption";
  if (notice?.status === "recovering") return "operational_action";
  if (row.disposition === "blocked" || row.work_status === "blocked" ||
    row.runtime_owned_open === 1 || row.unresolved_blockers > 0) return "attention";
  if (row.disposition === "completed" || row.work_status === "completed") return "completed";
  if (row.turn_state === "admitted" || row.turn_state === "delivery_committed") return "running";
  return "attention";
}

function actionCounts(value: string | null): { completed: number; total: number } {
  if (!value) return { completed: 0, total: 0 };
  try {
    const actions = JSON.parse(value);
    if (!Array.isArray(actions)) return { completed: 0, total: 0 };
    const statuses = actions.flatMap((action) =>
      isRecord(action) && typeof action.status === "string" ? [action.status] : [],
    );
    return {
      completed: statuses.filter((status) => status === "done" || status === "skipped").length,
      total: statuses.length,
    };
  } catch {
    return { completed: 0, total: 0 };
  }
}

function safeText(
  value: string | null,
  fallback: string,
  row: Pick<WorkStatusRow, "work_id" | "session_id" | "turn_id">,
): string {
  let text = stripControlCharacters(value ?? "");
  for (const internalId of [row.work_id, row.session_id, row.turn_id]) {
    if (internalId) text = text.split(internalId).join("internal reference");
  }
  text = text
    .replace(/(?:\/Users|\/home|\/var|\/tmp)\/[^\s),;]+/gu, "local path")
    .replace(/\b[A-Za-z]:\\[^\s),;]+/gu, "local path")
    .replace(/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+/giu, "[redacted]")
    .replace(/\s+/gu, " ")
    .trim();
  if (!text) return fallback;
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function countStates(items: WorkStatusItemView[]): Record<WorkStatusState, number> {
  const counts: Record<WorkStatusState, number> = {
    running: 0,
    completed: 0,
    attention: 0,
    operational_action: 0,
    operational_interruption: 0,
  };
  for (const item of items) counts[item.state] += 1;
  return counts;
}

function statePriority(state: WorkStatusState): number {
  if (state === "operational_interruption") return 0;
  if (state === "operational_action") return 1;
  if (state === "attention") return 2;
  if (state === "running") return 3;
  return 4;
}

function latestTimestamp(values: string[]): string {
  return values.reduce((latest, value) =>
    Date.parse(value) > Date.parse(latest) ? value : latest,
  );
}

function stripControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127 ? " " : character;
  }).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
