import type { ProgressRow } from "@/app/types.ts";

export type PhaseActivity = {
  id: string;
  phase?: string;
  summary: string;
  rationale: string;
  nextStep: string;
  createdAt?: string;
};

export function phaseActivityRows(rows: ProgressRow[]): PhaseActivity[] {
  return rows.flatMap((row) => {
    if (
      row.kind !== "message" ||
      row.work_block_id ||
      !row.semantic_block_id ||
      row.work_decision_source !== "model-authored" ||
      !row.work_decision_summary ||
      !row.work_decision_rationale ||
      !row.work_decision_next_step
    ) {
      return [];
    }
    return [{
      id: row.id,
      phase: row.semantic_block_id,
      summary: row.work_decision_summary,
      rationale: row.work_decision_rationale,
      nextStep: row.work_decision_next_step,
      createdAt: row.created_at,
    }];
  });
}

export function currentModelRoundWait(
  rows: ProgressRow[],
): ProgressRow | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row) continue;
    if (
      row.state === "delivered" ||
      row.state === "completed" ||
      row.state === "cancelled" ||
      row.state === "failed"
    ) {
      return undefined;
    }
    if (row.bridge_phase === "model_round_waiting") return row;
    if (
      row.work_decision_source === "model-authored" ||
      row.bridge_phase === "operational_recovery"
    ) {
      return undefined;
    }
  }
  return undefined;
}

export function latestPublicActivity(
  rows: ProgressRow[],
  hasModelActivity = false,
): ProgressRow | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (
      row &&
      row.kind === "message" &&
      row.state === "running" &&
      !row.work_block_id
    ) {
      if (row.bridge_phase === "model_round_waiting") return undefined;
      if (row.work_decision_source) return undefined;
      if (hasModelActivity && row.bridge_phase !== "operational_recovery") {
        return undefined;
      }
      if (row.safe_label.trim().length === 0) continue;
      return row;
    }
  }
  return undefined;
}

export function currentSemanticState(
  rows: ProgressRow[],
  activities: PhaseActivity[],
): string | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const semanticState = rows[index]?.semantic_block_id;
    if (semanticState) return semanticState;
  }
  return activities.at(-1)?.phase;
}
