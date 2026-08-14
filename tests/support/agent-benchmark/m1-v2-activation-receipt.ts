import { createHash } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import type { ProviderRequestObservation } from "../../e2e/btcc-r3-electron/provider-observation-proxy.ts";
import { FINAL_ACTIVATION, FINAL_AFTER_REVISION, FINAL_BEFORE_REVISION,
  type BenchmarkVersion, type M1V2ActivationIdentity } from "./paired-contract.ts";
import { AFTER_ONLY_AFTER_REVISION } from "./after-only-contract.ts";
import { hasUnsafeButlerRuntimeDirectoryComponent, isStrictlyInsideButlerRuntime } from "./butler-runtime-path-safety.ts";

const DEFAULT_LIMITS = {
  maxModelRequests: 60, maxToolRounds: 60, maxModelFacingBytes: 192 * 1024,
  maxCumulativeModelFacingBytes: 8 * 1024 * 1024, maxOutputBytes: 512 * 1024,
  maxElapsedMs: 2 * 60 * 60 * 1_000, maxIdleMs: 20 * 60 * 1_000,
} as const;

export interface M1V2RuntimeActivationReceipt {
  schema: "butler.m1-v2-runtime-activation-receipt.v1";
  version: BenchmarkVersion;
  sourceRevision: string;
  declaredActivation: M1V2ActivationIdentity;
  policyMode: "legacy" | "phase_minimal";
  policyRevision: "legacy" | "butler.btcc-tool-instruction-policy.v1";
  exactReplay: { enabled: boolean; referenceSchemaOwner: "butler.operation-result-reference.v1" | null };
  continuation: { admitted: boolean; schema: "butler.turn-continuation-budget.v2" | null; limits: typeof DEFAULT_LIMITS | null };
  stablePrefixRevision: "butler.btcc-stable-provider-prefix.v1" | null;
  routeCacheIdentity: ProviderRouteCacheReceipt | null;
  finalSerializer: "butler.openai-codex-final-json.v1";
  rawTextStored: false;
  identitySha256: string;
}

export function materializeM1V2RuntimeActivationReceipt(input: {
  runRoot: string; dataRoot: string; evidenceRoot: string; turnId: string; version: BenchmarkVersion;
  sourceRevision: string; declaredActivation: M1V2ActivationIdentity;
  providerRequests: readonly ProviderRequestObservation[];
}): M1V2RuntimeActivationReceipt {
  const runRoot = resolve(input.runRoot); const evidenceRoot = resolve(input.evidenceRoot);
  if (!isStrictlyInsideButlerRuntime(runRoot, evidenceRoot) ||
      hasUnsafeButlerRuntimeDirectoryComponent(evidenceRoot)) {
    throw new Error("m1_activation_receipt_evidence_root_invalid");
  }
  const expectedRevisions: readonly string[] = input.version === "before" ? [FINAL_BEFORE_REVISION] : [FINAL_AFTER_REVISION, AFTER_ONLY_AFTER_REVISION];
  if (!expectedRevisions.includes(input.sourceRevision) ||
      JSON.stringify(input.declaredActivation) !== JSON.stringify(FINAL_ACTIVATION[input.version])) {
    throw new Error("m1_activation_receipt_declared_identity_mismatch");
  }
  const agentRequests = input.providerRequests.filter((row) => row.requestKind === "agent");
  if (agentRequests.length === 0 || agentRequests.some((row) =>
      row.routeId !== "openai-codex-responses" ||
      row.serializerContract !== "butler.openai-codex-final-json.v1")) {
    throw new Error("m1_activation_final_serializer_unverified");
  }
  const db = readRuntimeState(input.dataRoot, input.turnId);
  const after = input.version === "after";
  const exactReplay = agentRequests.every((row) => row.exactResultReadSchemaObserved);
  if (after) {
    if (!exactReplay || !db.continuation || !sameLimits(db.continuation.limits, DEFAULT_LIMITS) ||
        !db.routeIdentity || db.routeIdentity.toolProfileRevision !== "butler.btcc-tool-instruction-policy.v1" ||
        db.routeIdentity.stablePrefixRevision !== "butler.btcc-stable-provider-prefix.v1" ||
        !validRouteIdentity(db.routeIdentity, agentRequests)) {
      throw new Error("m1_activation_flags_enabled_but_runtime_path_legacy");
    }
  } else if (exactReplay || db.continuation || db.routeIdentity) {
    throw new Error("m1_before_activation_not_legacy");
  }
  const stable = {
    schema: "butler.m1-v2-runtime-activation-receipt.v1" as const,
    version: input.version, sourceRevision: input.sourceRevision,
    declaredActivation: input.declaredActivation,
    policyMode: after ? "phase_minimal" as const : "legacy" as const,
    policyRevision: after ? "butler.btcc-tool-instruction-policy.v1" as const : "legacy" as const,
    exactReplay: { enabled: exactReplay, referenceSchemaOwner: exactReplay ? "butler.operation-result-reference.v1" as const : null },
    continuation: db.continuation ? { admitted: true, schema: "butler.turn-continuation-budget.v2" as const, limits: DEFAULT_LIMITS } : { admitted: false, schema: null, limits: null },
    stablePrefixRevision: db.routeIdentity ? "butler.btcc-stable-provider-prefix.v1" as const : null,
    routeCacheIdentity: db.routeIdentity ? projectRouteIdentity(db.routeIdentity) : null,
    finalSerializer: "butler.openai-codex-final-json.v1" as const, rawTextStored: false as const,
  };
  const receipt = { ...stable, identitySha256: digest(stable) };
  mkdirSync(evidenceRoot, { recursive: true });
  if (lstatSync(evidenceRoot).isSymbolicLink()) throw new Error("m1_activation_receipt_evidence_root_invalid");
  const target = join(evidenceRoot, "m1-v2-runtime-activation-receipt.json");
  if (!isStrictlyInsideButlerRuntime(evidenceRoot, target)) throw new Error("m1_activation_receipt_target_invalid");
  const temporary = `${target}.tmp`;
  if (existsSync(temporary)) throw new Error("m1_activation_receipt_temporary_conflict");
  if (existsSync(target)) return verifyExistingReceipt(target, receipt);
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    linkSync(temporary, target);
  } catch (error) {
    if (existsSync(target)) {
      unlinkSync(temporary);
      return verifyExistingReceipt(target, receipt);
    }
    throw error;
  }
  unlinkSync(temporary);
  return receipt;
}

type ProviderRouteCacheReceipt = {
  schemaVersion: "butler.provider-route-cache-identity.v1"; routeDigest: string; routeCursor: number;
  providerId: "openai-codex"; modelRef: string; authMode: "codex_subscription" | "codex_oauth";
  capabilityDigest: string; serializerContract: "butler.openai-codex-final-json.v1";
  toolProfileRevision: "butler.btcc-tool-instruction-policy.v1";
  stablePrefixRevision: "butler.btcc-stable-provider-prefix.v1";
  serializedStablePrefixSha256: string; serializedStablePrefixBytes: number;
};

const ROUTE_KEYS = ["schemaVersion", "routeDigest", "routeCursor", "providerId", "modelRef", "authMode",
  "capabilityDigest", "serializerContract", "toolProfileRevision", "stablePrefixRevision",
  "serializedStablePrefixSha256", "serializedStablePrefixBytes"].sort();
function validRouteIdentity(value: Record<string, unknown>, requests: readonly ProviderRequestObservation[]): boolean {
  const modelRef = value.modelRef;
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify(ROUTE_KEYS) &&
    value.schemaVersion === "butler.provider-route-cache-identity.v1" && sha(value.routeDigest) &&
    Number.isSafeInteger(value.routeCursor) && Number(value.routeCursor) >= 0 && value.providerId === "openai-codex" &&
    typeof modelRef === "string" && requests.every((request) => modelMatches(modelRef, request.requestedModel)) &&
    (value.authMode === "codex_subscription" || value.authMode === "codex_oauth") && sha(value.capabilityDigest) &&
    value.serializerContract === "butler.openai-codex-final-json.v1" &&
    value.toolProfileRevision === "butler.btcc-tool-instruction-policy.v1" &&
    value.stablePrefixRevision === "butler.btcc-stable-provider-prefix.v1" && sha(value.serializedStablePrefixSha256) &&
    Number.isSafeInteger(value.serializedStablePrefixBytes) && Number(value.serializedStablePrefixBytes) > 0;
}
function projectRouteIdentity(value: Record<string, unknown>): ProviderRouteCacheReceipt {
  return Object.fromEntries(ROUTE_KEYS.map((key) => [key, value[key]])) as ProviderRouteCacheReceipt;
}
function modelMatches(actual: string, observed: string | null): boolean {
  if (!observed) return false; const normalize = (value: string) => value.includes("/") ? value.slice(value.indexOf("/") + 1) : value;
  return normalize(actual) === normalize(observed);
}
function sha(value: unknown): boolean { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }

function verifyExistingReceipt(path: string, expected: M1V2RuntimeActivationReceipt): M1V2RuntimeActivationReceipt {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("m1_activation_receipt_existing_target_invalid");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as M1V2RuntimeActivationReceipt;
  const { identitySha256, ...stable } = parsed;
  if (identitySha256 !== digest(stable) || JSON.stringify(parsed) !== JSON.stringify(expected)) {
    throw new Error("m1_activation_receipt_existing_target_conflict");
  }
  return parsed;
}

function readRuntimeState(dataRoot: string, turnId: string): { continuation: { limits: Record<string, unknown> } | null; routeIdentity: Record<string, unknown> | null } {
  for (const path of sqlitePaths(dataRoot)) {
    const db = new Database(path, { readonly: true });
    try {
      if (!tableExists(db, "btcc_turns")) continue;
      const turn = db.query<{ continuation_budget_json: string | null }, [string]>(
        "SELECT continuation_budget_json FROM btcc_turns WHERE turn_id = ?",
      ).get(turnId);
      if (!turn) continue;
      const continuation = turn.continuation_budget_json ? JSON.parse(turn.continuation_budget_json) as Record<string, unknown> : null;
      if (continuation && continuation.schemaVersion !== "butler.turn-continuation-budget.v2") throw new Error("m1_continuation_schema_mismatch");
      let routeIdentity: Record<string, unknown> | null = null;
      if (tableExists(db, "btcc_model_round_acceptances")) {
        const rows = db.query<{ normalized_response_json: string }, [string]>(
          "SELECT normalized_response_json FROM btcc_model_round_acceptances WHERE turn_id = ? ORDER BY created_at",
        ).all(turnId);
        for (const row of rows) {
          const normalized = JSON.parse(row.normalized_response_json) as Record<string, unknown>;
          const candidate = record(record(normalized.continuation)?.providerRouteIdentity);
          if (candidate) routeIdentity = candidate;
        }
      }
      return { continuation: continuation ? { limits: record(continuation.limits) ?? {} } : null, routeIdentity };
    } finally { db.close(); }
  }
  throw new Error("m1_activation_turn_state_unavailable");
}

function sqlitePaths(root: string): string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    if (!existsSync(directory) || found.length >= 40) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && /\.sqlite(?:3)?$/u.test(entry.name)) found.push(path);
    }
  };
  visit(root); return found;
}
function tableExists(db: Database, name: string): boolean { return Boolean(db.query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)); }
function record(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function sameLimits(actual: Record<string, unknown>, expected: typeof DEFAULT_LIMITS): boolean {
  const actualKeys = Object.keys(actual).sort(); const expectedKeys = Object.keys(expected).sort();
  return JSON.stringify(actualKeys) === JSON.stringify(expectedKeys) &&
    expectedKeys.every((key) => actual[key] === expected[key as keyof typeof expected]);
}
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
