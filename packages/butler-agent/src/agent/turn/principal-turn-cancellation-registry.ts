import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  unwatchFile,
  watchFile,
  type Stats,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { writeJsonFileAtomic } from "../persistence/atomic-json-store.ts";

const CANCELLATION_SCHEMA = "butler.principal-turn-cancellation.v1";
const WATCH_INTERVAL_MS = 25;

interface RegisteredTurnController {
  butlerData: string;
  turnId: string;
  controller: AbortController;
  markerPath: string;
  listener: (current: Stats, previous: Stats) => void;
}

const controllersByTurn = new Map<string, Set<AbortController>>();
const registrationsBySignal = new WeakMap<AbortSignal, RegisteredTurnController>();

export function principalTurnCancellationMarkerPath(input: {
  butlerData: string;
  turnId: string;
}): string {
  const turnHash = createHash("sha256").update(requiredTurnId(input.turnId)).digest("hex");
  return join(resolve(input.butlerData), "state", "turn-cancellations", `${turnHash}.json`);
}

export function principalTurnCancellationRecorded(input: {
  butlerData: string;
  turnId: string;
}): boolean {
  return existsSync(principalTurnCancellationMarkerPath(input));
}

export function recordPrincipalTurnCancellation(input: {
  butlerData: string;
  turnId: string;
  now?: Date;
}): void {
  const markerPath = principalTurnCancellationMarkerPath(input);
  if (!existsSync(markerPath)) {
    writeJsonFileAtomic(markerPath, {
      schemaVersion: CANCELLATION_SCHEMA,
      turnIdHash: createHash("sha256").update(requiredTurnId(input.turnId)).digest("hex"),
      cancelledAt: (input.now ?? new Date()).toISOString(),
    });
  }
  abortRegisteredControllers(input.butlerData, input.turnId);
}

export function registerPrincipalTurnAbortController(input: {
  butlerData: string;
  turnId: string;
  controller: AbortController;
}): () => void {
  const butlerData = resolve(input.butlerData);
  const turnId = requiredTurnId(input.turnId);
  const markerPath = principalTurnCancellationMarkerPath({ butlerData, turnId });
  mkdirSync(dirname(markerPath), { recursive: true });
  const key = registryKey(butlerData, turnId);
  const controllers = controllersByTurn.get(key) ?? new Set<AbortController>();
  controllers.add(input.controller);
  controllersByTurn.set(key, controllers);
  const listener = () => {
    refreshPrincipalTurnAbortSignal(input.controller.signal);
  };
  const registration: RegisteredTurnController = {
    butlerData,
    turnId,
    controller: input.controller,
    markerPath,
    listener,
  };
  registrationsBySignal.set(input.controller.signal, registration);
  watchFile(markerPath, { interval: WATCH_INTERVAL_MS, persistent: false }, listener);
  refreshPrincipalTurnAbortSignal(input.controller.signal);

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    unwatchFile(markerPath, listener);
    registrationsBySignal.delete(input.controller.signal);
    const registered = controllersByTurn.get(key);
    registered?.delete(input.controller);
    if (registered?.size === 0) controllersByTurn.delete(key);
  };
}

export function refreshPrincipalTurnAbortSignal(signal: AbortSignal): boolean {
  const registration = registrationsBySignal.get(signal);
  if (!registration || !existsSync(registration.markerPath)) return false;
  abortController(registration.controller);
  return true;
}

function abortRegisteredControllers(butlerData: string, turnId: string): void {
  const controllers = controllersByTurn.get(registryKey(butlerData, turnId));
  for (const controller of controllers ?? []) abortController(controller);
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

function registryKey(butlerData: string, turnId: string): string {
  return `${resolve(butlerData)}\u0000${requiredTurnId(turnId)}`;
}

function requiredTurnId(value: string): string {
  const turnId = value.trim();
  if (!turnId) throw new Error("principal turn cancellation requires turnId");
  return turnId;
}
