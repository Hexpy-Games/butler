import { existsSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type {
  GuidedWorkObservation,
  PreparedRun,
} from "./contracts.ts";

interface WorkRow {
  work_id: string;
  status: string;
  plan_revision: number | null;
}

interface ValueRow {
  value: string;
}

const APP_DATABASE_CANDIDATES = [
  ["app-server", "butler-client.sqlite"],
  ["runtime", "butler-client.sqlite"],
  ["butler-client.sqlite"],
] as const;

function tableExists(db: Database, table: string): boolean {
  return Boolean(db.query<{ name: string }, [string]>(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `).get(table));
}

function openGuidedWorkDatabase(run: PreparedRun): Database | null {
  for (const parts of APP_DATABASE_CANDIDATES) {
    const path = join(run.dataRoot, ...parts);
    if (!existsSync(path)) continue;
    const db = new Database(path, { readonly: true });
    try {
      if (tableExists(db, "btcc_guided_works")) return db;
    } catch {
      // A concurrently initializing candidate is not yet the product Work store.
    }
    db.close();
  }
  return null;
}

function latestValue(
  db: Database,
  table: "btcc_guided_work_checkpoint_revisions" | "btcc_guided_work_review_revisions",
  column: "stage" | "verdict",
  workId: string,
  subject?: "plan" | "result",
): string | null {
  const row = subject
    ? db.query<ValueRow, [string, string]>(`
        SELECT ${column} AS value FROM ${table}
        WHERE work_id = ? AND subject = ?
        ORDER BY revision DESC LIMIT 1
      `).get(workId, subject)
    : db.query<ValueRow, [string]>(`
        SELECT ${column} AS value FROM ${table}
        WHERE work_id = ?
        ORDER BY revision DESC LIMIT 1
      `).get(workId);
  return row?.value ?? null;
}

/**
 * Reads only lifecycle metadata needed by the product E2E assertion. In
 * particular, this deliberately never selects the tool-call result_json column.
 */
export function readGuidedWorkObservation(
  run: PreparedRun,
  turnId: string,
): GuidedWorkObservation | null {
  const db = openGuidedWorkDatabase(run);
  if (!db) return null;
  try {
    const work = db.query<WorkRow, [string]>(`
      SELECT work.work_id, work.status, plan.revision AS plan_revision
      FROM btcc_guided_turn_work_bindings binding
      JOIN btcc_guided_works work ON work.work_id = binding.work_id
      LEFT JOIN btcc_guided_work_plan_revisions plan
        ON plan.plan_revision_id = work.current_plan_revision_id
      WHERE binding.turn_id = ? AND binding.is_current = 1
      LIMIT 1
    `).get(turnId);
    if (!work) return null;
    const resultToolNames = db.query<{ tool_name: string }, [string]>(`
      SELECT call.tool_name
      FROM btcc_guided_work_results result
      JOIN btcc_guided_tool_calls call ON call.call_id = result.tool_call_id
      WHERE result.work_id = ?
      ORDER BY result.sequence
    `).all(work.work_id).map((row) => row.tool_name);
    return {
      workId: work.work_id,
      status: work.status,
      planRevision: work.plan_revision,
      checkpointStage: latestValue(
        db,
        "btcc_guided_work_checkpoint_revisions",
        "stage",
        work.work_id,
      ),
      planReviewVerdict: latestValue(
        db,
        "btcc_guided_work_review_revisions",
        "verdict",
        work.work_id,
        "plan",
      ),
      resultReviewVerdict: latestValue(
        db,
        "btcc_guided_work_review_revisions",
        "verdict",
        work.work_id,
        "result",
      ),
      resultToolNames,
    };
  } finally {
    db.close();
  }
}
