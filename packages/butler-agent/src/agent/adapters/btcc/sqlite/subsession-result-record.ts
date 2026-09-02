import type { Database } from "bun:sqlite";
import { stableJson } from "../../../btcc/identity/index.ts";
import {
  aggregateChangedFileDetails,
  type ChangedFileDetail,
} from "../../../tools/file-tools/shared/changed-file-detail.ts";
import type {
  StewardResultCode,
  StewardResultEnvelope,
  StewardResultStatus,
} from "../../../btcc/subsessions/index.ts";

type ResultRow = {
  result_id: string;
  relation_id: string;
  task_id: string;
  child_session_id: string;
  child_turn_id: string;
  status: StewardResultStatus;
  code: StewardResultCode | null;
  summary: string;
  acceptance_evidence_json: string;
  changed_artifacts_json: string;
  changed_files_json: string;
  commits_json: string;
  tests_json: string;
  remaining_risks_json: string;
  follow_up_recommendations_json: string;
  detail_refs_json: string;
  created_at: string;
};

export function readStewardResult(
  db: Database,
  relationId: string,
): StewardResultEnvelope | null {
  const row = db.query<ResultRow, [string]>(`
    SELECT result_id, relation_id, task_id, child_session_id, child_turn_id,
      status, code, summary, acceptance_evidence_json, changed_artifacts_json,
      changed_files_json,
      commits_json, tests_json, remaining_risks_json,
      follow_up_recommendations_json, detail_refs_json, created_at
    FROM btcc_steward_results WHERE relation_id = ?
  `).get(relationId);
  return row ? {
    result_id: row.result_id,
    relation_id: row.relation_id,
    task_id: row.task_id,
    child_session_id: row.child_session_id,
    child_turn_id: row.child_turn_id,
    status: row.status,
    code: row.code ?? null,
    summary: row.summary,
    acceptance_evidence: JSON.parse(row.acceptance_evidence_json) as string[],
    changed_artifacts: JSON.parse(row.changed_artifacts_json) as string[],
    changed_files: row.changed_files_json
      ? JSON.parse(row.changed_files_json) as NonNullable<StewardResultEnvelope["changed_files"]>
      : [],
    commits: JSON.parse(row.commits_json) as string[],
    tests: JSON.parse(row.tests_json) as string[],
    remaining_risks: JSON.parse(row.remaining_risks_json) as string[],
    follow_up_recommendations: JSON.parse(row.follow_up_recommendations_json) as string[],
    detail_refs: JSON.parse(row.detail_refs_json) as string[],
    created_at: row.created_at,
  } : null;
}

export function insertStewardResult(db: Database, result: StewardResultEnvelope): void {
  db.query(`
    INSERT INTO btcc_steward_results (
      result_id, relation_id, task_id, child_session_id, child_turn_id,
      status, code, summary, acceptance_evidence_json, changed_artifacts_json,
      changed_files_json,
      commits_json, tests_json, remaining_risks_json,
      follow_up_recommendations_json, detail_refs_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    result.result_id, result.relation_id, result.task_id, result.child_session_id,
    result.child_turn_id, result.status, result.code, result.summary,
    stableJson(result.acceptance_evidence), stableJson(result.changed_artifacts),
    stableJson(result.changed_files ?? []),
    stableJson(result.commits), stableJson(result.tests), stableJson(result.remaining_risks),
    stableJson(result.follow_up_recommendations), stableJson(result.detail_refs), result.created_at,
  );
}

/** One delegated session and its Workers share a result, even across review continuations. */
export function collectSubsessionChangedFiles(
  db: Database,
  childSessionId: string,
  reported: readonly ChangedFileDetail[],
): ChangedFileDetail[] {
  const mutations = db.query<{ changed_files_json: string }, [string, string]>(`
    SELECT calls.changed_files_json
    FROM btcc_turns AS turns
    JOIN btcc_guided_tool_calls AS calls ON calls.turn_id = turns.turn_id
    WHERE turns.session_id IN (
      SELECT ? UNION ALL
      SELECT child_session_id FROM btcc_session_relations WHERE parent_session_id = ?
    ) AND calls.status = 'completed' AND calls.changed_files_json IS NOT NULL
    ORDER BY calls.finished_at, calls.rowid
  `).all(childSessionId, childSessionId).flatMap((row) =>
    JSON.parse(row.changed_files_json) as ChangedFileDetail[]);
  const recordedPaths = new Set(mutations.map((detail) => detail.path));
  return aggregateChangedFileDetails([
    // Preserve supplied details without a local mutation record. Recorded paths
    // use their full history, including a net-zero reversion in a later Turn.
    ...reported.filter((detail) => !recordedPaths.has(detail.path)),
    ...mutations,
  ]);
}

export function safeStewardSummary(value: string): string {
  return value.replace(/\s+/gu, " ").replace(/[\\/]Users[\\/][^ ]+/gu, "workspace artifact")
    .trim().slice(0, 1_000) || "Steward could not provide a usable report.";
}

export function renderParentResult(result: StewardResultEnvelope): string {
  return [
    "Subsession result",
    `Relation ref: ${result.relation_id}`,
    `Result ref: ${result.result_id}`,
    `Status: ${result.status}`,
    ...(result.code ? [`Code: ${result.code}`] : []),
    `Summary: ${result.summary}`,
    `Acceptance evidence: ${result.acceptance_evidence.join("; ")}`,
    `Changed artifacts: ${result.changed_artifacts.join("; ") || "none"}`,
    `Commits: ${result.commits.join("; ") || "none"}`,
    `Tests: ${result.tests.join("; ") || "none"}`,
    `Remaining risks: ${result.remaining_risks.join("; ") || "none"}`,
    `Follow-up recommendations: ${result.follow_up_recommendations.join("; ") || "none"}`,
    `Detail refs: ${result.detail_refs.join("; ") || "none"}`,
  ].join("\n");
}
