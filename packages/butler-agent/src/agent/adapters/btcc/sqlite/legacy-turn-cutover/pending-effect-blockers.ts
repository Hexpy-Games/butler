import type { Database } from "bun:sqlite";
import { digest } from "../identity.ts";
import type {
  LegacyTurnCutoverBlocker,
  PendingLegacyTurnCutoverBlocker,
} from "./contracts.ts";

const SAFE_PENDING_OPERATION_KINDS = new Set([
  "observe",
  "workspace_artifact_action",
  "workspace_artifact_observation",
  "review_validation",
  "turn_local_effect",
]);

export function pendingCutoverBlockers(
  db: Database,
  turnId: string,
  activeCheckpointId: string | null,
): PendingLegacyTurnCutoverBlocker[] {
  return [
    ...pendingPhaseEffectBlockers(db, turnId, activeCheckpointId),
    ...pendingProjectLedgerPromotionBlockers(db, turnId),
    ...pendingGuidedEffectBlockers(db, turnId),
  ].sort(compareBlockers);
}

function pendingPhaseEffectBlockers(
  db: Database,
  turnId: string,
  activeCheckpointId: string | null,
): PendingLegacyTurnCutoverBlocker[] {
  if (!activeCheckpointId || !tableExists(db, "btcc_phase_checkpoint_revisions")) {
    return [];
  }
  const row = db.query<{ pending_operation_json: string | null }, [string]>(`
    SELECT revision.pending_operation_json
    FROM btcc_checkpoints checkpoint
    LEFT JOIN btcc_phase_checkpoint_revisions revision
      ON revision.checkpoint_id = checkpoint.checkpoint_id
      AND revision.checkpoint_revision = checkpoint.checkpoint_revision
    WHERE checkpoint.checkpoint_id = ? AND checkpoint.is_active = 1
  `).get(activeCheckpointId);
  if (!row?.pending_operation_json) return [];

  let value: unknown;
  try {
    value = JSON.parse(row.pending_operation_json);
  } catch {
    return [unreadablePendingOperation(turnId, activeCheckpointId)];
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [unreadablePendingOperation(turnId, activeCheckpointId)];
  }
  const carrier = value as Record<string, unknown>;
  if (carrier.kind !== "operation_requests" || !Array.isArray(carrier.requests)) {
    return [unreadablePendingOperation(turnId, activeCheckpointId)];
  }

  const blockers: PendingLegacyTurnCutoverBlocker[] = [];
  for (const [index, valueRequest] of carrier.requests.entries()) {
    if (!valueRequest || typeof valueRequest !== "object" ||
      Array.isArray(valueRequest)) {
      blockers.push(unreadablePendingOperation(
        turnId,
        `${activeCheckpointId}:${index}`,
      ));
      continue;
    }
    const request = valueRequest as Record<string, unknown>;
    const requestId = text(request.requestId) ??
      `${activeCheckpointId}:request-${index + 1}`;
    if (isRuntimeRejected(request.runtimeAdmission)) continue;
    if (request.kind === "external_effect") {
      blockers.push(...pendingExternalEffectBlockers(turnId, requestId, request));
      continue;
    }
    if (request.kind === "repository_promotion") {
      blockers.push({
        turnId,
        kind: "pending_repository_promotion",
        referenceId: requestId,
        detail: "A legacy repository promotion request has no committed result.",
      });
      continue;
    }
    if (typeof request.kind !== "string" ||
      !SAFE_PENDING_OPERATION_KINDS.has(request.kind)) {
      blockers.push(unreadablePendingOperation(turnId, requestId));
    }
  }
  return blockers;
}

function pendingProjectLedgerPromotionBlockers(
  db: Database,
  turnId: string,
): PendingLegacyTurnCutoverBlocker[] {
  if (!tableExists(db, "btcc_ledger_promotion_outbox")) return [];
  return db.query<{ outbox_id: string }, [string]>(`
    SELECT outbox_id FROM btcc_ledger_promotion_outbox
    WHERE turn_id = ? AND status = 'pending'
    ORDER BY committed_turn_revision, outbox_id
  `).all(turnId).map((row) => ({
    turnId,
    kind: "pending_project_ledger_promotion" as const,
    referenceId: row.outbox_id,
    detail: "A Project Ledger promotion Outbox still requires reconciliation.",
  }));
}

function pendingGuidedEffectBlockers(
  db: Database,
  turnId: string,
): PendingLegacyTurnCutoverBlocker[] {
  if (
    !tableExists(db, "btcc_guided_turn_work_bindings") ||
    !tableExists(db, "btcc_guided_effects")
  ) return [];
  return db.query<{
    effect_id: string;
    status: string;
    capability: string;
  }, [string]>(`
    SELECT effect.effect_id, effect.status, effect.capability
    FROM btcc_guided_turn_work_bindings binding
    JOIN btcc_guided_effects effect ON effect.work_id = binding.work_id
    WHERE binding.turn_id = ? AND binding.is_current = 1
      AND effect.status IN ('prepared', 'dispatching', 'uncertain')
    ORDER BY effect.effect_id
  `).all(turnId).map((row) => ({
    turnId,
    kind: "pending_guided_effect" as const,
    referenceId: row.effect_id,
    detail:
      `Guided effect ${row.capability} remains ${row.status} and requires reconciliation.`,
  }));
}

function tableExists(db: Database, table: string): boolean {
  return Boolean(db.query<{ present: number }, [string]>(`
    SELECT 1 AS present FROM sqlite_schema
    WHERE type = 'table' AND name = ?
  `).get(table));
}

function unreadablePendingOperation(
  turnId: string,
  referenceId: string,
): LegacyTurnCutoverBlocker {
  return {
    turnId,
    kind: "pending_operation_unreadable",
    referenceId,
    detail: "A pending legacy operation cannot be classified safely.",
  };
}

function pendingExternalEffectBlockers(
  turnId: string,
  requestId: string,
  request: Record<string, unknown>,
): PendingLegacyTurnCutoverBlocker[] {
  const detail = "A legacy external effect request has no committed result.";
  const capability = text(request.capabilityRef);
  const sourceTarget = text(request.targetScopeRef);
  const occurrenceKey = text(request.occurrenceKey);
  const input = record(request.input);
  const effectIntentRef = record(request.effectIntentRef);
  const effectIntentId = text(effectIntentRef?.id);
  const effectIntentSha256 = text(effectIntentRef?.sha256);
  if (
    !capability ||
    !sourceTarget ||
    !occurrenceKey ||
    !input ||
    !effectIntentId ||
    !effectIntentSha256
  ) {
    return [{
      turnId,
      kind: "pending_external_effect",
      referenceId: requestId,
      detail,
    }];
  }
  const sourceOccurrenceId = digest(
    `btcc-r3-legacy-effect-occurrence.v1\0${turnId}\0${requestId}\0${occurrenceKey}`,
  );
  const idempotencyKey = [
    effectIntentId,
    effectIntentSha256,
    occurrenceKey,
  ].join(":");
  return exactLegacyTargets(capability, sourceTarget, input).map((target) => ({
    turnId,
    kind: "pending_external_effect" as const,
    referenceId: requestId,
    detail,
    capability,
    target,
    reconciliation: {
      sourceOccurrenceId,
      capability,
      target,
      input,
      idempotencyKey,
    },
  }));
}

function exactLegacyTargets(
  capability: string,
  sourceTarget: string,
  input: Record<string, unknown>,
): string[] {
  if (capability !== "project_ledger_update" || !Array.isArray(input.updates)) {
    return [sourceTarget];
  }
  const targets = input.updates.flatMap((value) => {
    const update = record(value);
    const id = text(update?.id);
    if (!id) return [];
    const kind = text(update?.kind) ?? "*";
    return [`project-ledger:${kind}:${id}`];
  });
  return targets.length > 0 ? [...new Set(targets)].sort() : [sourceTarget];
}

function isRuntimeRejected(value: unknown): boolean {
  return Boolean(
    value && typeof value === "object" && !Array.isArray(value) &&
    (value as Record<string, unknown>).kind === "rejected",
  );
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function compareBlockers(
  left: LegacyTurnCutoverBlocker,
  right: LegacyTurnCutoverBlocker,
): number {
  return left.turnId.localeCompare(right.turnId) ||
    left.kind.localeCompare(right.kind) ||
    left.referenceId.localeCompare(right.referenceId);
}
