import type { Database } from "bun:sqlite";
import type {
  AcceptedPhaseGuidance,
  PhaseGuidanceDraft,
  PhaseGuidanceRepository,
  PhaseGuidanceRevisionRef,
  PhaseGuidanceScope,
  PublishPhaseGuidanceCommand,
} from "../../../btcc/gateway-api.ts";
import { digest, stableJson } from "./identity.ts";

type GuidanceRow = {
  guidance_json: string;
};
type GuidanceRevisionRow = GuidanceRow & { status: "active" | "superseded" };
type ModelPhaseState = AcceptedPhaseGuidance["phase"];

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
    const guidanceIds = new Set<string>();
    return rows.flatMap((row) => {
      const guidance = decodeGuidance(row.guidance_json);
      if (!guidance || guidanceIds.has(guidance.guidanceId)) return [];
      guidanceIds.add(guidance.guidanceId);
      return [guidance];
    });
  }

  publish(
    command: PublishPhaseGuidanceCommand,
  ): AcceptedPhaseGuidance {
    validateInput(command.guidance);
    return this.db.transaction(() => {
      return command.disposition === "promote"
        ? this.promote(command.guidance)
        : this.revise(command);
    })();
  }

  private promote(guidance: PhaseGuidanceDraft): AcceptedPhaseGuidance {
    const scope = storageScope(guidance.scope);
    const accepted = createAcceptedGuidance(guidance, "promote", 1);
    const current = this.current(guidance.guidanceId, guidance.phase, scope);
    if (current?.contentSha256 === accepted.contentSha256) return current;
    if (current || this.hasHistory(guidance.guidanceId, guidance.phase, scope)) {
      throw new Error("phase_guidance_promote_requires_new_stable_id");
    }
    this.insert(accepted, scope);
    return accepted;
  }

  private revise(
    command: Extract<PublishPhaseGuidanceCommand, { disposition: "merge" | "supersede" }>,
  ): AcceptedPhaseGuidance {
    const scope = storageScope(command.guidance.scope);
    validateRevisionIdentity(command.target, command.guidance);
    const targetRow = this.revision(command.target);
    const target = targetRow ? decodeGuidance(targetRow.guidance_json) : null;
    if (!target || !sameRevision(target, command.target)) {
      throw new Error("phase_guidance_target_revision_missing");
    }
    const guidance = preserveProvenance(target, command.guidance);
    const accepted = createAcceptedGuidance(
      guidance,
      command.disposition,
      target.revision + 1,
      command.target,
    );
    const current = this.current(guidance.guidanceId, guidance.phase, scope);
    if (current?.contentSha256 === accepted.contentSha256) return current;
    if (targetRow?.status !== "active" || !current || !sameRevision(current, command.target)) {
      throw new Error("phase_guidance_target_revision_not_active");
    }
    const updated = this.db.query(`
      UPDATE btcc_phase_guidance SET status = 'superseded'
      WHERE guidance_id = ? AND phase = ? AND scope_kind = ? AND scope_id = ?
        AND revision = ? AND content_sha256 = ? AND status = 'active'
    `).run(
      command.target.guidanceId,
      command.target.phase,
      scope.kind,
      scope.id,
      command.target.revision,
      command.target.contentSha256,
    );
    if (updated.changes !== 1) throw new Error("phase_guidance_target_revision_raced");
    this.insert(accepted, scope);
    return accepted;
  }

  private insert(
    accepted: AcceptedPhaseGuidance,
    scope: { kind: string; id: string },
  ): void {
    this.db.query(`
      INSERT INTO btcc_phase_guidance (
        guidance_revision_id, guidance_id, phase, scope_kind, scope_id,
        revision, status, content_sha256, guidance_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
    `).run(
      digest(`btcc-phase-guidance.v1\0${accepted.guidanceId}\0${accepted.phase}\0${scope.kind}\0${scope.id}\0${accepted.revision}`),
      accepted.guidanceId,
      accepted.phase,
      scope.kind,
      scope.id,
      accepted.revision,
      accepted.contentSha256,
      stableJson(accepted),
      new Date().toISOString(),
    );
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

  private hasHistory(
    guidanceId: string,
    phase: ModelPhaseState,
    scope: { kind: string; id: string },
  ): boolean {
    return Boolean(this.db.query<{ found: number }, [string, string, string, string]>(`
      SELECT 1 AS found FROM btcc_phase_guidance
      WHERE guidance_id = ? AND phase = ? AND scope_kind = ? AND scope_id = ? LIMIT 1
    `).get(guidanceId, phase, scope.kind, scope.id));
  }

  private revision(ref: PhaseGuidanceRevisionRef): GuidanceRevisionRow | null {
    const scope = storageScope(ref.scope);
    return this.db.query<GuidanceRevisionRow, [string, string, string, string, number, string]>(`
      SELECT guidance_json, status FROM btcc_phase_guidance
      WHERE guidance_id = ? AND phase = ? AND scope_kind = ? AND scope_id = ?
        AND revision = ? AND content_sha256 = ? LIMIT 1
    `).get(
      ref.guidanceId,
      ref.phase,
      scope.kind,
      scope.id,
      ref.revision,
      ref.contentSha256,
    ) ?? null;
  }
}

function storageScope(scope: PhaseGuidanceScope) {
  return scope.kind === "project"
    ? { kind: "project" as const, id: scope.projectRef }
    : { kind: "user" as const, id: scope.userRef };
}

function validateInput(
  input: PhaseGuidanceDraft,
): void {
  if (!input.guidanceId.trim() || !input.guidance.trim()) {
    throw new Error("BTCC phase guidance requires an id and guidance text");
  }
  if (!input.scopeRationale.trim() || input.scopeSourceRefs.length === 0) {
    throw new Error("BTCC phase guidance requires reviewed scope authority");
  }
  if (
    input.scope.kind === "user" &&
    input.generalityBoundary !== "cross_project_user_preference"
  ) throw new Error("User guidance requires a cross-project boundary");
  if (
    input.scope.kind === "project" &&
    input.generalityBoundary !== "project_bound_strategy"
  ) throw new Error("Project guidance requires a project-bound boundary");
  const scope = storageScope(input.scope);
  if (!scope.id.trim()) throw new Error("BTCC phase guidance requires a scope id");
}

function validateRevisionIdentity(
  target: PhaseGuidanceRevisionRef,
  guidance: PhaseGuidanceDraft,
): void {
  if (
    target.guidanceId !== guidance.guidanceId ||
    target.phase !== guidance.phase ||
    !sameScope(target.scope, guidance.scope)
  ) throw new Error("phase_guidance_revision_identity_changed");
}

function preserveProvenance(
  target: AcceptedPhaseGuidance,
  guidance: PhaseGuidanceDraft,
): PhaseGuidanceDraft {
  return {
    ...guidance,
    scopeSourceRefs: union(target.scopeSourceRefs, guidance.scopeSourceRefs),
    sourceIds: union(target.sourceIds, guidance.sourceIds),
  };
}

function createAcceptedGuidance(
  guidance: PhaseGuidanceDraft,
  revisionKind: AcceptedPhaseGuidance["revisionKind"],
  revision: number,
  predecessor?: PhaseGuidanceRevisionRef,
): AcceptedPhaseGuidance {
  const content = { ...guidance, revisionKind, ...(predecessor ? { predecessor } : {}) };
  return {
    ...content,
    revision,
    contentSha256: digest(stableJson(content)),
  };
}

function sameRevision(
  guidance: AcceptedPhaseGuidance,
  ref: PhaseGuidanceRevisionRef,
): boolean {
  return guidance.guidanceId === ref.guidanceId && guidance.phase === ref.phase &&
    sameScope(guidance.scope, ref.scope) && guidance.revision === ref.revision &&
    guidance.contentSha256 === ref.contentSha256;
}

function sameScope(left: PhaseGuidanceScope, right: PhaseGuidanceScope): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "user"
    ? left.userRef === (right as Extract<PhaseGuidanceScope, { kind: "user" }>).userRef
    : left.projectRef === (right as Extract<PhaseGuidanceScope, { kind: "project" }>).projectRef;
}

function union(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right])];
}

function decodeGuidance(value: string): AcceptedPhaseGuidance | null {
  try {
    const parsed = JSON.parse(value) as Partial<AcceptedPhaseGuidance>;
    if (
      typeof parsed.guidanceId !== "string" ||
      typeof parsed.phase !== "string" ||
      !PHASES.has(parsed.phase as ModelPhaseState) ||
      typeof parsed.guidance !== "string" ||
      typeof parsed.scopeRationale !== "string" ||
      !Array.isArray(parsed.scopeSourceRefs) ||
      (parsed.generalityBoundary !== "cross_project_user_preference" &&
        parsed.generalityBoundary !== "project_bound_strategy") ||
      !Number.isInteger(parsed.revision) || Number(parsed.revision) < 1 ||
      (parsed.revisionKind !== "promote" && parsed.revisionKind !== "merge" &&
        parsed.revisionKind !== "supersede") ||
      typeof parsed.contentSha256 !== "string" ||
      !Array.isArray(parsed.appliesWhen) ||
      !Array.isArray(parsed.doesNotApplyWhen) ||
      !Array.isArray(parsed.sourceIds) ||
      !validScope(parsed.scope)
    ) return null;
    if (
      (parsed.scope.kind === "user" &&
        parsed.generalityBoundary !== "cross_project_user_preference") ||
      (parsed.scope.kind === "project" &&
        parsed.generalityBoundary !== "project_bound_strategy")
    ) return null;
    if (
      (parsed.revisionKind === "promote" && parsed.predecessor !== undefined) ||
      (parsed.revisionKind !== "promote" && !validRevisionRef(parsed.predecessor))
    ) return null;
    const guidance = parsed as AcceptedPhaseGuidance;
    return hasValidContentHash(guidance) ? guidance : null;
  } catch {
    return null;
  }
}

function hasValidContentHash(guidance: AcceptedPhaseGuidance): boolean {
  const content = { ...guidance } as Partial<AcceptedPhaseGuidance>;
  delete content.revision;
  delete content.contentSha256;
  return digest(stableJson(content)) === guidance.contentSha256;
}

function validRevisionRef(value: unknown): value is PhaseGuidanceRevisionRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as Partial<PhaseGuidanceRevisionRef>;
  return typeof ref.guidanceId === "string" && typeof ref.phase === "string" &&
    PHASES.has(ref.phase as ModelPhaseState) && Number.isInteger(ref.revision) &&
    Number(ref.revision) > 0 && typeof ref.contentSha256 === "string" &&
    Boolean(ref.contentSha256) && validScope(ref.scope);
}

function validScope(value: unknown): value is PhaseGuidanceScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scope = value as Partial<PhaseGuidanceScope> & Record<string, unknown>;
  return scope.kind === "user"
    ? typeof scope.userRef === "string" && Boolean(scope.userRef)
    : scope.kind === "project" && typeof scope.projectRef === "string" &&
      Boolean(scope.projectRef);
}
