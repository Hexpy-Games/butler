import type { Database } from "bun:sqlite";
import type {
  AcceptedPhaseGuidance,
  PhaseGuidanceDraft,
  PhaseGuidanceRepository,
  PhaseGuidanceRevisionRef,
  PublishPhaseGuidanceCommand,
} from "../../../btcc/gateway-api.ts";
import { digest, stableJson } from "./identity.ts";
import {
  createAcceptedGuidance,
  decodeGuidance,
  type GuidanceStorageScope,
  type ModelPhaseState,
  preserveGuidanceProvenance,
  sameGuidanceRevision,
  storageScope,
  validateGuidanceDraft,
  validateRevisionIdentity,
} from "./phase-guidance/guidance-codec.ts";

type GuidanceRow = {
  guidance_json: string;
};
type GuidanceRevisionRow = GuidanceRow & { status: "active" | "superseded" };
export class SqlitePhaseGuidanceStore implements PhaseGuidanceRepository {
  constructor(private readonly db: Database) {}

  list(input: {
    phase: ModelPhaseState;
    userRef: string;
    sessionId: string;
    projectRef?: string;
  }): AcceptedPhaseGuidance[] {
    const rows = this.db.query<GuidanceRow, [string, string, string, string]>(`
      SELECT guidance_json
      FROM btcc_phase_guidance
      WHERE status = 'active'
        AND phase = ?
        AND (
          (scope_kind = 'session' AND scope_id = ?)
          OR (scope_kind = 'project' AND scope_id = ?)
          OR (scope_kind = 'user' AND scope_id = ?)
          OR (scope_kind = 'global' AND scope_id = 'global')
        )
      ORDER BY
        CASE scope_kind
          WHEN 'session' THEN 0
          WHEN 'project' THEN 1
          WHEN 'user' THEN 2
          ELSE 3
        END,
        guidance_id ASC,
        revision DESC
    `).all(input.phase, input.sessionId, input.projectRef ?? "", input.userRef);
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
    validateGuidanceDraft(command.guidance);
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
    if (!target || !sameGuidanceRevision(target, command.target)) {
      throw new Error("phase_guidance_target_revision_missing");
    }
    const guidance = preserveGuidanceProvenance(target, command.guidance);
    const accepted = createAcceptedGuidance(
      guidance,
      command.disposition,
      target.revision + 1,
      command.target,
    );
    const current = this.current(guidance.guidanceId, guidance.phase, scope);
    if (current?.contentSha256 === accepted.contentSha256) return current;
    if (targetRow?.status !== "active" || !current || !sameGuidanceRevision(current, command.target)) {
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
    scope: GuidanceStorageScope,
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
    scope: GuidanceStorageScope,
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
    scope: GuidanceStorageScope,
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
