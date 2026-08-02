import type { Database } from "bun:sqlite";
import type { GuidedWorkEffectBlockerRecord } from
  "../../../btcc/effects/index.ts";
import { digest, stableJson } from "./identity.ts";

export class SqliteGuidedEffectBlockerStore {
  constructor(private readonly db: Database) {}

  listForReconciliation(workId: string): GuidedWorkEffectBlockerRecord[] {
    return this.db.query<{
      blocker_id: string;
      source_turn_id: string;
      source_occurrence_id: string;
      work_id: string;
      capability: string;
      target: string;
      input_json: string;
      input_sha256: string;
      idempotency_key: string;
      detail: string;
      status: "unresolved" | "applied";
      resolution_json: string | null;
      created_at: string;
    }, [string]>(`
      SELECT blocker_id, source_turn_id, source_occurrence_id, work_id,
        capability, target, input_json, input_sha256, idempotency_key,
        detail, status, resolution_json, created_at
      FROM btcc_guided_work_effect_blockers
      WHERE work_id = ? AND status IN ('unresolved', 'applied')
      ORDER BY created_at, blocker_id
    `).all(workId).map(hydrateBlocker);
  }

  resolveOccurrence(
    workId: string,
    sourceOccurrenceId: string,
    resolution: "applied" | "not_applied",
  ): boolean {
    return this.resolve(
      workId,
      "source_occurrence_id",
      sourceOccurrenceId,
      resolution,
    );
  }

  private resolve(
    workId: string,
    selector: "source_occurrence_id",
    value: string,
    resolution: "applied" | "not_applied",
  ): boolean {
    return this.db.transaction(() => {
      const resolvedAt = new Date().toISOString();
      const updated = this.db.query(`
        UPDATE btcc_guided_work_effect_blockers SET status = ?,
          resolution_json = ?, resolved_at = ?
        WHERE work_id = ? AND ${selector} = ?
          AND status = 'unresolved'
      `).run(
        resolution,
        stableJson({ status: resolution }),
        resolvedAt,
        workId,
        value,
      );
      const remaining = this.db.query<{ present: number }, [string]>(`
        SELECT 1 AS present FROM btcc_guided_work_effect_blockers
        WHERE work_id = ? AND status = 'unresolved' LIMIT 1
      `).get(workId);
      if (!remaining) {
        this.db.query(`
          UPDATE btcc_guided_works SET status = 'open', updated_at = ?
          WHERE work_id = ? AND status = 'blocked'
        `).run(resolvedAt, workId);
      }
      return updated.changes > 0;
    })();
  }
}

function hydrateBlocker(row: {
  blocker_id: string;
  source_turn_id: string;
  source_occurrence_id: string;
  work_id: string;
  capability: string;
  target: string;
  input_json: string;
  input_sha256: string;
  idempotency_key: string;
  detail: string;
  status: "unresolved" | "applied";
  resolution_json: string | null;
  created_at: string;
}): GuidedWorkEffectBlockerRecord {
  if (digest(row.input_json) !== row.input_sha256) {
    throw new Error(`Guided Work effect blocker input is corrupted: ${row.blocker_id}`);
  }
  const parsed = JSON.parse(row.input_json) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Guided Work effect blocker input is invalid: ${row.blocker_id}`);
  }
  const resolution = blockerResolution(row);
  return {
    blockerId: row.blocker_id,
    sourceTurnId: row.source_turn_id,
    sourceOccurrenceId: row.source_occurrence_id,
    workId: row.work_id,
    capability: row.capability,
    target: row.target,
    input: parsed as Record<string, unknown>,
    inputSha256: row.input_sha256,
    idempotencyKey: row.idempotency_key,
    detail: row.detail,
    status: row.status,
    ...(resolution ? { resolution } : {}),
    createdAt: row.created_at,
  };
}

function blockerResolution(row: {
  blocker_id: string;
  status: "unresolved" | "applied";
  resolution_json: string | null;
}): { status: "applied" | "not_applied" } | undefined {
  if (row.status === "unresolved") {
    if (row.resolution_json !== null) {
      throw new Error(
        `Unresolved Guided Work blocker has a resolution: ${row.blocker_id}`,
      );
    }
    return undefined;
  }
  const parsed = row.resolution_json
    ? JSON.parse(row.resolution_json) as { status?: unknown }
    : null;
  if (parsed?.status !== row.status) {
    throw new Error(
      `Guided Work blocker resolution is invalid: ${row.blocker_id}`,
    );
  }
  return { status: parsed.status };
}
