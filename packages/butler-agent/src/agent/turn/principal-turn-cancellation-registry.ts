import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveAppGatewayRuntimeConfig } from "../../operations/gateway/registry.ts";

export interface PrincipalTurnExecutionIdentity {
  butlerData: string;
  turnId: string;
  queueId: string;
  dispatchClaimId: string;
}

interface RegisteredTurnController extends PrincipalTurnExecutionIdentity {
  controller: AbortController;
  abortDeliveredAt?: number;
}

const CANCELLATION_STALLED_AFTER_MS = 2_000;

const registrations = new Map<string, RegisteredTurnController>();
const registrationsBySignal = new WeakMap<AbortSignal, RegisteredTurnController>();
const locallyRecordedTurns = new Set<string>();

export function principalTurnCancellationRecorded(input: {
  butlerData: string;
  turnId: string;
}): boolean {
  if (locallyRecordedTurns.has(turnKey(input))) return true;
  const dbPath = appTurnStateDbPath(input.butlerData);
  if (!existsSync(dbPath)) return false;
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db
      .query<{ state: string }, [string]>("SELECT state FROM turns WHERE id = ?")
      .get(requiredToken(input.turnId, "turnId"));
    return row?.state === "cancelling" || row?.state === "cancelled";
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

export function recordPrincipalTurnCancellation(input: {
  butlerData: string;
  turnId: string;
}): void {
  locallyRecordedTurns.add(turnKey(input));
  for (const registration of registrations.values()) {
    if (turnKey(registration) === turnKey(input)) {
      registration.abortDeliveredAt ??= Date.now();
      abortController(registration.controller);
    }
  }
}

export function registerPrincipalTurnAbortController(
  input: PrincipalTurnExecutionIdentity & { controller: AbortController },
): () => void {
  const registration: RegisteredTurnController = {
    butlerData: resolve(input.butlerData),
    turnId: requiredToken(input.turnId, "turnId"),
    queueId: requiredToken(input.queueId, "queueId"),
    dispatchClaimId: requiredToken(input.dispatchClaimId, "dispatchClaimId"),
    controller: input.controller,
  };
  const key = registryKey(registration);
  registrations.set(key, registration);
  registrationsBySignal.set(input.controller.signal, registration);
  refreshPrincipalTurnAbortSignal(input.controller.signal);

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (registrations.get(key)?.controller === input.controller) {
      registrations.delete(key);
    }
    registrationsBySignal.delete(input.controller.signal);
  };
}

export function refreshPrincipalTurnAbortSignal(signal: AbortSignal): boolean {
  const registration = registrationsBySignal.get(signal);
  if (!registration || !principalTurnCancellationRecorded(registration)) {
    return false;
  }
  registration.abortDeliveredAt ??= Date.now();
  abortController(registration.controller);
  return true;
}

export function abortPrincipalTurnExecution(
  input: PrincipalTurnExecutionIdentity,
): "signal_dispatched" | "already_settled" | "execution_identity_mismatch" {
  const exact = registrations.get(registryKey(input));
  if (exact) {
    if (exact.controller.signal.aborted) return "already_settled";
    exact.abortDeliveredAt = Date.now();
    abortController(exact.controller);
    return "signal_dispatched";
  }
  const sameTurnExists = [...registrations.values()].some(
    (registration) =>
      registration.butlerData === resolve(input.butlerData) &&
      registration.turnId === input.turnId,
  );
  return sameTurnExists ? "execution_identity_mismatch" : "already_settled";
}

export function abortDurablyCancelledPrincipalTurnExecutions(
  butlerData: string,
): number {
  const root = resolve(butlerData);
  const active = [...registrations.values()].filter(
    (registration) => registration.butlerData === root,
  );
  const cancelledTurnIds = durablyCancelledTurnIds(root, active);
  let aborted = 0;
  for (const registration of active) {
    if (!cancelledTurnIds.has(registration.turnId)) continue;
    if (!registration.controller.signal.aborted) {
      registration.abortDeliveredAt = Date.now();
      abortController(registration.controller);
      markPrincipalTurnCancellationDelivery(
        registration,
        "accepted",
      );
      aborted += 1;
    } else if (
      registration.abortDeliveredAt &&
      Date.now() - registration.abortDeliveredAt >= CANCELLATION_STALLED_AFTER_MS
    ) {
      markPrincipalTurnCancellationStalled(registration);
    }
  }
  return aborted;
}

function durablyCancelledTurnIds(
  butlerData: string,
  registrationsForRoot: RegisteredTurnController[],
): Set<string> {
  const turnIds = [...new Set(
    registrationsForRoot.map((registration) => registration.turnId),
  )];
  const cancelled = new Set(
    turnIds.filter((turnId) =>
      locallyRecordedTurns.has(turnKey({ butlerData, turnId })),
    ),
  );
  if (turnIds.length === 0) return cancelled;
  const dbPath = appTurnStateDbPath(butlerData);
  if (!existsSync(dbPath)) return cancelled;
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const placeholders = turnIds.map(() => "?").join(", ");
    const rows = db
      .query<{ id: string }, string[]>(`
        SELECT id FROM turns
        WHERE state IN ('cancelling', 'cancelled')
          AND id IN (${placeholders})
      `)
      .all(...turnIds);
    for (const row of rows) cancelled.add(row.id);
  } catch {
    return cancelled;
  } finally {
    db?.close();
  }
  return cancelled;
}

function markPrincipalTurnCancellationStalled(
  input: PrincipalTurnExecutionIdentity,
): void {
  const dbPath = appTurnStateDbPath(input.butlerData);
  if (!existsSync(dbPath)) return;
  let db: Database | null = null;
  try {
    db = new Database(dbPath);
    db.transaction(() => {
      db?.query(`
        UPDATE app_turn_cancel_outbox
        SET safe_error_code = 'cancellation_stalled'
        WHERE turn_id = ? AND state != 'completed'
      `).run(input.turnId);
      db?.query(`
        UPDATE turns
        SET safe_error_code = 'cancellation_stalled',
          safe_status_label = 'Stopping is taking longer than expected'
        WHERE id = ? AND state = 'cancelling'
      `).run(input.turnId);
    })();
  } catch {
    // Retry on the next existing service tick.
  } finally {
    db?.close();
  }
}

export function markPrincipalTurnCancellationDelivery(
  input: PrincipalTurnExecutionIdentity,
  state: "accepted" | "completed",
): void {
  const dbPath = appTurnStateDbPath(input.butlerData);
  if (!existsSync(dbPath)) return;
  let db: Database | null = null;
  try {
    db = new Database(dbPath);
    const timestampColumn = state === "accepted" ? "accepted_at" : "completed_at";
    db.query(`
      UPDATE app_turn_cancel_outbox
      SET state = ?, ${timestampColumn} = ?
      WHERE turn_id = ?
        AND queue_id = ?
        AND dispatch_claim_id = ?
        AND state != 'completed'
    `).run(
      state,
      new Date().toISOString(),
      input.turnId,
      input.queueId,
      input.dispatchClaimId,
    );
  } catch {
    // The existing service tick retries while the controller remains active.
  } finally {
    db?.close();
  }
}

export function activePrincipalTurnExecutionCount(butlerData?: string): number {
  if (!butlerData) return registrations.size;
  const root = resolve(butlerData);
  return [...registrations.values()].filter(
    (registration) => registration.butlerData === root,
  ).length;
}

function abortController(controller: AbortController): void {
  if (controller.signal.aborted) return;
  const error = Object.assign(
    new Error("Runtime turn was cancelled by the principal."),
    { code: "turn_cancelled" },
  );
  error.name = "AbortError";
  controller.abort(error);
}

function appTurnStateDbPath(butlerData: string): string {
  const root = resolve(butlerData);
  return (
    resolveAppGatewayRuntimeConfig({ butlerData: root }).dbPath ??
    join(root, "app-server", "butler-client.sqlite")
  );
}

function registryKey(input: PrincipalTurnExecutionIdentity): string {
  return [
    resolve(input.butlerData),
    requiredToken(input.turnId, "turnId"),
    requiredToken(input.queueId, "queueId"),
    requiredToken(input.dispatchClaimId, "dispatchClaimId"),
  ].join("\u0000");
}

function turnKey(input: { butlerData: string; turnId: string }): string {
  return `${resolve(input.butlerData)}\u0000${requiredToken(input.turnId, "turnId")}`;
}

function requiredToken(value: string, label: string): string {
  const token = value.trim();
  if (!token) throw new Error(`principal turn cancellation requires ${label}`);
  return token;
}
