import { runSandyCorrection } from "./sandy-correction-apply.ts";
import { readSandyCorrection } from "./sandy-correction-snapshot.ts";
import {
  assertCanonicalSandyTarget,
  defaultCaptureCheckpoint,
  defaultCapturePlan,
  defaultMonitoringDisposition,
  SANDY_CAPTURE_TURN_IDS,
  SANDY_MONITORING_TURN_IDS,
  SANDY_SESSION_ID,
  SANDY_SOURCE_WORK_ID,
} from "./sandy-correction-contracts.ts";
import type {
  SandyCorrectionExpectation,
  SandyCorrectionInput,
  SandyCorrectionResult,
  SandyCorrectionTarget,
} from "./sandy-correction-contracts.ts";

export type SandyCorrectionCliInput = {
  target: SandyCorrectionTarget;
  prepareLive: boolean;
  expected?: SandyCorrectionExpectation;
  apply: boolean;
  ownerStopped: boolean;
  backupDir?: string;
  ownerStopManifestPath?: string;
  operatorReason: string;
  operatorId?: string;
  manifestPath?: string;
};

export function parseSandyCorrectionCli(args: readonly string[]): SandyCorrectionCliInput {
  const dbPath = value(args, "--db");
  const prepareLive = args[0] === "prepare-live" || args.includes("--prepare-live");
  const sessionId = value(args, "--session") ?? SANDY_SESSION_ID;
  const sourceWorkId = value(args, "--source-work") ?? SANDY_SOURCE_WORK_ID;
  const monitoringTurnIds = values(args, "--monitoring-turn");
  const captureTurnIds = values(args, "--capture-turn");
  if (!dbPath) throw new Error("correction sandy requires --db");
  if (monitoringTurnIds.length !== 0 && monitoringTurnIds.length !== 2) {
    throw new Error("correction sandy accepts exactly two --monitoring-turn values");
  }
  if (captureTurnIds.length !== 0 && captureTurnIds.length !== 2) {
    throw new Error("correction sandy accepts exactly two --capture-turn values");
  }
  const canonicalMonitoringTurnIds = (monitoringTurnIds.length === 0
    ? SANDY_MONITORING_TURN_IDS
    : monitoringTurnIds) as [string, string];
  const canonicalCaptureTurnIds = (captureTurnIds.length === 0
    ? SANDY_CAPTURE_TURN_IDS
    : captureTurnIds) as [string, string];
  assertCanonicalSandyTarget({
    dbPath,
    sessionId,
    sourceWorkId,
    monitoringTurnIds: canonicalMonitoringTurnIds,
    captureTurnIds: canonicalCaptureTurnIds,
  });
  const apply = args.includes("--apply");
  return {
    target: {
      dbPath,
      sessionId,
      sourceWorkId,
      monitoringTurnIds: canonicalMonitoringTurnIds,
      captureTurnIds: canonicalCaptureTurnIds,
    },
    prepareLive,
    expected: parseExpected(args),
    apply,
    ownerStopped: args.includes("--owner-stopped"),
    ...(value(args, "--backup-dir") ? { backupDir: value(args, "--backup-dir")! } : {}),
    ...(value(args, "--owner-manifest") ? { ownerStopManifestPath: value(args, "--owner-manifest")! } : {}),
    ...(value(args, "--manifest") ? { manifestPath: value(args, "--manifest")! } : {}),
    operatorReason: value(args, "--reason") ?? "",
    ...(value(args, "--operator-id") ? { operatorId: value(args, "--operator-id")! } : {}),
  };
}

export function executeSandyCorrectionCli(input: SandyCorrectionCliInput): SandyCorrectionResult {
  const read = readSandyCorrection(input.target);
  if (input.apply && !input.expected) {
    throw new Error("apply requires all explicit --expected-* identity fields from a prior dry run");
  }
  if (input.apply && !input.operatorId?.trim()) {
    throw new Error("apply requires --operator-id");
  }
  if (input.apply && !input.operatorReason.trim()) {
    throw new Error("apply requires --reason");
  }
  if (input.apply && !input.backupDir) {
    throw new Error("apply requires --backup-dir for the backup identity");
  }
  const expected = input.expected ?? {
    sourceStatus: "open" as const,
    bindingCount: read.sourceBindingCount,
    resultCount: read.sourceResultCount,
    bindingDigest: read.bindingDigest,
    resultDigest: read.resultDigest,
    sourceIdentitySha256: read.identity.sha256,
    beforeSnapshotSha256: read.beforeSnapshotSha256,
  };
  const correction: SandyCorrectionInput = {
    ...input.target,
    expected,
    disposition: defaultMonitoringDisposition(input.target.monitoringTurnIds),
    capturePlan: defaultCapturePlan(),
    captureCheckpoint: defaultCaptureCheckpoint(input.target.captureTurnIds[1]),
    operatorReason: input.operatorReason,
    ...(input.operatorId ? { operatorId: input.operatorId } : {}),
    apply: input.apply,
    ownerStopped: input.ownerStopped,
    ...(input.backupDir ? { backupDir: input.backupDir } : {}),
    ...(input.ownerStopManifestPath ? { ownerStopManifestPath: input.ownerStopManifestPath } : {}),
  };
  return runSandyCorrection(correction);
}

export function redactSandyCorrectionResult(result: SandyCorrectionResult): Record<string, unknown> {
  return {
    status: result.status,
    request_fingerprint: result.requestFingerprint,
    operator_id: result.operatorId ?? null,
    before_snapshot_sha256: result.beforeSnapshotSha256,
    after_snapshot_sha256: result.afterSnapshotSha256 ?? null,
    audit_id: result.auditId ?? null,
    target: {
      session_id: result.read.target.sessionId,
      source_work_id: result.read.target.sourceWorkId,
      monitoring_turn_ids: result.read.target.monitoringTurnIds,
      capture_turn_ids: result.read.target.captureTurnIds,
    },
    observed: {
      source_status: result.read.sourceWork.status,
      source_binding_count: result.read.sourceBindingCount,
      source_result_count: result.read.sourceResultCount,
      monitoring_result_count: result.read.monitoringResultCount,
      capture_result_count: result.read.captureResultCount,
      selected_tool_journal_count: result.read.selectedToolJournalCount,
      selected_tool_journal_digest: result.read.selectedToolJournalDigest,
      session_head_work_id: result.read.sessionHeadWorkId,
      binding_digest: result.read.bindingDigest,
      result_digest: result.read.resultDigest,
      database_identity_sha256: result.read.identity.sha256,
    },
    after: result.after ? {
      monitoring_binding_count: result.after.monitoringBindingCount,
      capture_binding_count: result.after.captureBindingCount,
      monitoring_result_count: result.after.monitoringResultCount,
      capture_result_count: result.after.captureResultCount,
      monitoring_result_sequence: result.after.monitoringResultSequence,
      capture_result_sequence: result.after.captureResultSequence,
      session_head_work_id: result.after.sessionHeadWorkId,
    } : null,
    backup: result.backup ? {
      bundle_identity: result.backup.bundleIdentity,
      sqlite_snapshot_sha256: result.backup.sqliteSnapshotSha256,
      file_count: result.backup.files.length,
    } : null,
  };
}

function parseExpected(args: readonly string[]): SandyCorrectionExpectation | undefined {
  const fields = {
    sourceStatus: value(args, "--expected-status"),
    bindingCount: value(args, "--expected-bindings"),
    resultCount: value(args, "--expected-results"),
    bindingDigest: value(args, "--expected-binding-digest"),
    resultDigest: value(args, "--expected-result-digest"),
    sourceIdentitySha256: value(args, "--expected-db-sha256"),
    beforeSnapshotSha256: value(args, "--expected-snapshot-sha256"),
  };
  const supplied = Object.values(fields).some((field) => field !== null);
  if (!supplied) return undefined;
  if (fields.sourceStatus !== "open" || !fields.bindingCount || !fields.resultCount ||
    !fields.bindingDigest || !fields.resultDigest || !fields.sourceIdentitySha256 ||
    !fields.beforeSnapshotSha256) {
    throw new Error("all --expected-* correction identity fields are required together");
  }
  return {
    sourceStatus: "open",
    bindingCount: parseCount(fields.bindingCount, "--expected-bindings"),
    resultCount: parseCount(fields.resultCount, "--expected-results"),
    bindingDigest: fields.bindingDigest,
    resultDigest: fields.resultDigest,
    sourceIdentitySha256: fields.sourceIdentitySha256,
    beforeSnapshotSha256: fields.beforeSnapshotSha256,
  };
}

function parseCount(valueText: string, option: string): number {
  const parsed = Number(valueText);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${option} must be a non-negative integer`);
  return parsed;
}

function value(args: readonly string[], option: string): string | null {
  const index = args.indexOf(option);
  if (index < 0) return null;
  const valueText = args[index + 1];
  if (!valueText || valueText.startsWith("--")) throw new Error(`${option} requires a value`);
  return valueText;
}

function values(args: readonly string[], option: string): string[] {
  const output: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== option) continue;
    const valueText = args[index + 1];
    if (!valueText || valueText.startsWith("--")) throw new Error(`${option} requires a value`);
    output.push(valueText);
    index += 1;
  }
  return output;
}
