import type { Database } from "bun:sqlite";
import type { ModelPhaseState } from "../../../btcc/core/index.ts";
import type {
  AcceptedPhaseGuidance,
  PhaseGuidanceRepository,
  PhaseGuidanceScope,
} from "../../../btcc/guidance/index.ts";
import { digest, stableJson } from "./identity.ts";

type GuidanceRow = {
  guidance_json: string;
};

const PHASES = new Set<ModelPhaseState>([
  "conception_opening",
  "conception_deliberation",
  "contract_review",
  "planning",
  "planning_review",
  "task_execution",
  "task_review",
  "feedback_conception",
  "feedback_planning",
  "feedback_planning_review",
  "consolidation",
  "reporting",
]);

export class SqlitePhaseGuidanceStore implements PhaseGuidanceRepository {
  constructor(private readonly db: Database) {}

  list(input: {
    phase: ModelPhaseState;
    userRef: string;
    projectRef?: string;
  }): AcceptedPhaseGuidance[] {
    const rows = this.db.query<GuidanceRow, [string, string, string]>(`
      SELECT guidance_json
      FROM btcc_phase_guidance
      WHERE status = 'active'
        AND phase = ?
        AND (
          (scope_kind = 'project' AND scope_id = ?)
          OR (scope_kind = 'user' AND scope_id = ?)
        )
      ORDER BY
        CASE scope_kind WHEN 'project' THEN 0 ELSE 1 END,
        guidance_id ASC,
        revision DESC
    `).all(input.phase, input.projectRef ?? "", input.userRef);
    return rows.flatMap((row) => {
      const guidance = decodeGuidance(row.guidance_json);
      return guidance ? [guidance] : [];
    });
  }

  publish(
    input: Omit<AcceptedPhaseGuidance, "revision" | "contentSha256">,
  ): AcceptedPhaseGuidance {
    validateInput(input);
    return this.db.transaction(() => {
      const scope = storageScope(input.scope);
      const current = this.current(input.guidanceId, input.phase, scope);
      const contentSha256 = digest(stableJson(input));
      if (current?.contentSha256 === contentSha256) return current;

      const accepted: AcceptedPhaseGuidance = {
        ...input,
        revision: (current?.revision ?? 0) + 1,
        contentSha256,
      };
      this.db.query(`
        UPDATE btcc_phase_guidance
        SET status = 'superseded'
        WHERE guidance_id = ? AND phase = ?
          AND scope_kind = ? AND scope_id = ? AND status = 'active'
      `).run(input.guidanceId, input.phase, scope.kind, scope.id);
      this.db.query(`
        INSERT INTO btcc_phase_guidance (
          guidance_revision_id, guidance_id, phase, scope_kind, scope_id,
          revision, status, content_sha256, guidance_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
      `).run(
        digest(`btcc-phase-guidance.v1\0${input.guidanceId}\0${input.phase}\0${scope.kind}\0${scope.id}\0${accepted.revision}`),
        input.guidanceId,
        input.phase,
        scope.kind,
        scope.id,
        accepted.revision,
        contentSha256,
        stableJson(accepted),
        new Date().toISOString(),
      );
      return accepted;
    })();
  }

  private current(
    guidanceId: string,
    phase: ModelPhaseState,
    scope: { kind: string; id: string },
  ): AcceptedPhaseGuidance | null {
    const row = this.db.query<GuidanceRow, [string, string, string, string]>(`
      SELECT guidance_json
      FROM btcc_phase_guidance
      WHERE guidance_id = ? AND phase = ?
        AND scope_kind = ? AND scope_id = ? AND status = 'active'
      LIMIT 1
    `).get(guidanceId, phase, scope.kind, scope.id);
    return row ? decodeGuidance(row.guidance_json) : null;
  }
}

function storageScope(scope: PhaseGuidanceScope) {
  return scope.kind === "project"
    ? { kind: "project" as const, id: scope.projectRef }
    : { kind: "user" as const, id: scope.userRef };
}

function validateInput(
  input: Omit<AcceptedPhaseGuidance, "revision" | "contentSha256">,
): void {
  if (!input.guidanceId.trim() || !input.guidance.trim()) {
    throw new Error("BTCC phase guidance requires an id and guidance text");
  }
  const scope = storageScope(input.scope);
  if (!scope.id.trim()) throw new Error("BTCC phase guidance requires a scope id");
}

function decodeGuidance(value: string): AcceptedPhaseGuidance | null {
  try {
    const parsed = JSON.parse(value) as Partial<AcceptedPhaseGuidance>;
    if (
      typeof parsed.guidanceId !== "string" ||
      typeof parsed.phase !== "string" ||
      !PHASES.has(parsed.phase as ModelPhaseState) ||
      typeof parsed.guidance !== "string" ||
      typeof parsed.revision !== "number" ||
      typeof parsed.contentSha256 !== "string" ||
      !Array.isArray(parsed.appliesWhen) ||
      !Array.isArray(parsed.doesNotApplyWhen) ||
      !Array.isArray(parsed.sourceIds) ||
      !parsed.scope ||
      (parsed.scope.kind !== "user" && parsed.scope.kind !== "project")
    ) return null;
    return parsed as AcceptedPhaseGuidance;
  } catch {
    return null;
  }
}
