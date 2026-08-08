import { Database } from "bun:sqlite";
import {
  assertCanonicalSandyTarget,
  defaultCaptureCheckpoint,
  defaultCapturePlan,
  defaultMonitoringDisposition,
  correctionRequestFingerprint,
  type SandyAfterSnapshot,
  type SandyCorrectionInput,
  type SandyCorrectionRead,
  type SandyCorrectionResult,
} from "./sandy-correction-contracts.ts";
import {
  assertExpectedSnapshot,
  assertCanonicalSandyRead,
  assertTargetRows,
  readSandyCorrection,
  readSandyCorrectionFromDatabase,
} from "./sandy-correction-snapshot.ts";
import { backupSandyDatabase } from "./sandy-correction-backup.ts";
import { readDatabaseIdentity, sameStableDatabaseIdentity } from "./sandy-correction-identity.ts";
import {
  createCapturePlanAndCheckpoint,
  createCaptureWork,
  moveCaptureBindings,
  moveCaptureResults,
} from "./sandy-correction-evidence.ts";
import { ensureCorrectionSchema, hasTable } from "./sandy-correction-schema.ts";
import { recordMonitoringDisposition } from "./sandy-correction-disposition.ts";
import {
  isCanonicalSandyDatabase,
  readSandyOwnerStopManifestDigest,
  verifySandyOwnerStop,
} from "./sandy-correction-owners.ts";
import {
  SANDY_CORRECTION_VERSION,
  SANDY_SOURCE_ACTION_KEYS,
  SANDY_SOURCE_PLAN_REVISION_ID,
  sha256,
  stableJson,
} from "./sandy-correction-contracts.ts";
import {
  assertLiveSource,
  buildAfterSnapshot,
  assertTransactionPostconditions,
  insertCorrectionAudit,
  updateSessionHead,
} from "./sandy-correction-transaction.ts";

type AuditRow = {
  audit_id: string;
  request_fingerprint: string;
  after_snapshot_sha256: string;
  correction_version: number;
  operator_id: string;
  backup_identity: string;
  backup_json: string;
  after_snapshot_json: string;
};

export function runSandyCorrection(input: SandyCorrectionInput): SandyCorrectionResult {
  assertCanonicalSandyTarget(input);
  return runSandyCorrectionEngine({
    ...input,
    disposition: defaultMonitoringDisposition(input.monitoringTurnIds),
    capturePlan: defaultCapturePlan(),
    captureCheckpoint: defaultCaptureCheckpoint(input.captureTurnIds[1]),
  });
}

export function runSandyCorrectionEngine(input: SandyCorrectionInput): SandyCorrectionResult {
  const read = readSandyCorrection(input);
  const ownerStopManifestSha256 = input.apply && isCanonicalSandyDatabase(input.dbPath) && input.ownerStopManifestPath
    ? readSandyOwnerStopManifestDigest(input.ownerStopManifestPath)
    : undefined;
  const effectiveInput = ownerStopManifestSha256
    ? { ...input, ownerStopManifestSha256 }
    : input;
  const requestFingerprint = correctionRequestFingerprint(effectiveInput);
  const existing = readAudit(input.dbPath, requestFingerprint);
  if (existing) {
    assertReplayAfterState(effectiveInput, read, existing);
    return {
      status: "already_applied",
      requestFingerprint,
      operatorId: effectiveInput.operatorId,
      beforeSnapshotSha256: read.beforeSnapshotSha256,
      afterSnapshotSha256: existing.after_snapshot_sha256,
      read,
      auditId: existing.audit_id,
    };
  }
  verifySandyOwnerStop(effectiveInput, read.identity);
  assertExpectedSnapshot(read, effectiveInput.expected);
  assertCanonicalSandyRead(read);
  assertTargetRows(read);
  if (!effectiveInput.apply) {
    return {
      status: "dry_run",
      requestFingerprint,
      beforeSnapshotSha256: read.beforeSnapshotSha256,
      read,
    };
  }
  if (!effectiveInput.ownerStopped) {
    throw new Error("Sandy correction apply requires ownerStopped=true");
  }
  if (!effectiveInput.operatorId?.trim()) {
    throw new Error("Sandy correction apply requires operatorId");
  }
  if (!effectiveInput.operatorReason.trim()) {
    throw new Error("Sandy correction apply requires operatorReason");
  }
  if (!effectiveInput.backupDir) {
    throw new Error("Sandy correction apply requires backupDir");
  }
  const backup = backupSandyDatabase({
    dbPath: effectiveInput.dbPath,
    backupDir: effectiveInput.backupDir,
    requestFingerprint,
    ownerStopped: effectiveInput.ownerStopped,
    ownerManifestSha256: effectiveInput.ownerStopManifestSha256,
  });
  // Backup/VACUUM can be lengthy on the live database. Recheck the bounded
  // owner state and manifest immediately before opening the write transaction.
  verifySandyOwnerStop(effectiveInput, readDatabaseIdentity(effectiveInput.dbPath));
  const db = new Database(effectiveInput.dbPath);
  try {
    const now = effectiveInput.now ?? new Date().toISOString();
    let after!: SandyAfterSnapshot & { afterSnapshotSha256: string };
    db.transaction(() => {
      const txRead = readSandyCorrectionFromDatabase(db, effectiveInput);
      assertExpectedSnapshot(txRead, effectiveInput.expected, { allowVolatileIdentity: true });
      assertCanonicalSandyRead(txRead);
      assertTargetRows(txRead);
      assertReadMatches(read, txRead);
      assertLiveSource(db, effectiveInput, txRead);
      // DDL is deliberately after the authoritative read/assertions. SQLite
      // increments schema_version for newly-created correction tables, which
      // must not invalidate the source identity captured by the dry run.
      ensureCorrectionSchema(db);
      let captureWork = createCaptureWork(db, effectiveInput, txRead, now);
      moveCaptureBindings(db, effectiveInput, captureWork.workId);
      moveCaptureResults(db, effectiveInput, txRead.results, captureWork.workId);
      captureWork = createCapturePlanAndCheckpoint(
        db,
        effectiveInput,
        captureWork,
        now,
        requestFingerprint,
      );
      recordMonitoringDisposition(db, effectiveInput, txRead, now, requestFingerprint);
      updateSessionHead(db, effectiveInput.sessionId, captureWork.workId, now);
      assertTransactionPostconditions(db, effectiveInput, txRead, captureWork.workId, false);
      after = buildAfterSnapshot(db, effectiveInput, captureWork, requestFingerprint);
      const auditId = `sandy-correction-audit-${requestFingerprint}`;
      insertCorrectionAudit({
        db,
        auditId,
        requestFingerprint,
        input: effectiveInput,
        read,
        after,
        backup,
        now,
      });
      assertTransactionPostconditions(db, effectiveInput, txRead, captureWork.workId, true);
    }).immediate();
    return {
      status: "applied",
      requestFingerprint,
      operatorId: effectiveInput.operatorId,
      beforeSnapshotSha256: read.beforeSnapshotSha256,
      afterSnapshotSha256: after!.afterSnapshotSha256,
      read,
      after,
      backup,
      auditId: `sandy-correction-audit-${requestFingerprint}`,
    };
  } finally {
    db.close();
  }
}

function readAudit(dbPath: string, fingerprint: string): AuditRow | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    if (!hasTable(db, "btcc_operator_correction_audits")) return null;
    return db.query<AuditRow, [string]>(`
      SELECT audit_id, request_fingerprint, after_snapshot_sha256,
        correction_version, operator_id, backup_identity, backup_json, after_snapshot_json
      FROM btcc_operator_correction_audits WHERE request_fingerprint = ?
    `).get(fingerprint) ?? null;
  } finally {
    db.close();
  }
}

function assertReplayAfterState(
  input: SandyCorrectionInput,
  read: SandyCorrectionRead,
  audit: AuditRow,
): void {
  if (audit.correction_version !== SANDY_CORRECTION_VERSION ||
    audit.request_fingerprint !== correctionRequestFingerprint(input) ||
    audit.operator_id !== input.operatorId?.trim() || !audit.backup_identity) {
    throw new Error("existing correction audit does not match the immutable request identity");
  }
  if (isCanonicalSandyDatabase(input.dbPath)) {
    if (!input.ownerStopManifestPath ||
      readSandyOwnerStopManifestDigest(input.ownerStopManifestPath) !== readBackupManifestDigest(audit.backup_json)) {
      throw new Error("existing correction audit owner manifest does not match replay");
    }
  }
  let after: {
    captureWorkId?: string;
    captureWork?: { workId?: string };
    sessionHeadWorkId?: string;
    monitoringBindingCount?: number;
    captureBindingCount?: number;
    monitoringResultCount?: number;
    captureResultCount?: number;
    monitoringResultSequence?: number[];
    captureResultSequence?: number[];
  };
  try {
    after = JSON.parse(audit.after_snapshot_json) as typeof after;
  } catch {
    throw new Error("existing correction audit after snapshot is invalid");
  }
  if (sha256(stableJson(after)) !== audit.after_snapshot_sha256) {
    throw new Error("existing correction audit after snapshot hash is invalid");
  }
  const captureWorkId = after.captureWorkId ?? after.captureWork?.workId;
  if (!captureWorkId || after.sessionHeadWorkId !== captureWorkId ||
    after.monitoringBindingCount !== 2 || after.captureBindingCount !== 2 ||
    after.monitoringResultCount !== 128 || after.captureResultCount !== 181 ||
    after.monitoringResultSequence?.length !== 128 || after.captureResultSequence?.length !== 181 ||
    after.monitoringResultSequence.some((value, index) => value !== index + 1) ||
    after.captureResultSequence.some((value, index) => value !== index + 1)) {
    throw new Error("existing correction audit after-state postconditions do not match");
  }
  const db = new Database(input.dbPath, { readonly: true });
  try {
    const source = db.query<{ status: string; current_plan_revision_id: string | null }, [string]>(
      "SELECT status, current_plan_revision_id FROM btcc_guided_works WHERE work_id = ?",
    ).get(input.sourceWorkId);
    const capture = db.query<{ status: string; current_plan_revision_id: string | null }, [string]>(
      "SELECT status, current_plan_revision_id FROM btcc_guided_works WHERE work_id = ?",
    ).get(captureWorkId);
    const head = db.query<{ work_id: string }, [string]>(
      "SELECT work_id FROM btcc_guided_work_session_heads WHERE session_id = ?",
    ).get(input.sessionId);
    const sourceResults = countResults(db, input.sourceWorkId);
    const captureResults = countResults(db, captureWorkId);
    const disposition = db.query<{ count: number }, [string]>(
      "SELECT COUNT(*) AS count FROM btcc_guided_work_disposition_revisions WHERE work_id = ? AND disposition = 'completed'",
    ).get(input.sourceWorkId)?.count ?? 0;
    const checkpoint = db.query<{ plan_revision_id: string; result_sequence: number; action_states_json: string }, [string]>(
      "SELECT plan_revision_id, result_sequence, action_states_json FROM btcc_guided_work_checkpoint_revisions WHERE work_id = ? ORDER BY revision DESC LIMIT 1",
    ).get(input.sourceWorkId);
    if (!source || source.status !== "completed" || source.current_plan_revision_id !== SANDY_SOURCE_PLAN_REVISION_ID ||
      !capture || capture.status !== "open" || !capture.current_plan_revision_id || head?.work_id !== captureWorkId ||
      sourceResults !== 128 || captureResults !== 181 || disposition !== 1 || !checkpoint ||
      checkpoint.plan_revision_id !== SANDY_SOURCE_PLAN_REVISION_ID || checkpoint.result_sequence !== 128 ||
      !allDoneCheckpoint(checkpoint.action_states_json)) {
      throw new Error("existing correction audit current after-state no longer matches");
    }
  } finally {
    db.close();
  }
}

function readBackupManifestDigest(backupJson: string): string {
  try {
    const backup = JSON.parse(backupJson) as { ownerManifestSha256?: unknown };
    if (typeof backup.ownerManifestSha256 !== "string" || !backup.ownerManifestSha256) {
      throw new Error("missing owner manifest identity");
    }
    return backup.ownerManifestSha256;
  } catch {
    throw new Error("existing correction audit backup identity is invalid");
  }
}

function countResults(db: Database, workId: string): number {
  return Number(db.query<{ count: number }, [string]>(
    "SELECT COUNT(*) AS count FROM btcc_guided_work_results WHERE work_id = ?",
  ).get(workId)?.count ?? 0);
}

function allDoneCheckpoint(actionStatesJson: string): boolean {
  try {
    const states = JSON.parse(actionStatesJson) as Array<{ actionKey?: string; status?: string }>;
    return states.length === SANDY_SOURCE_ACTION_KEYS.length && states.every((state, index) =>
      state.actionKey === SANDY_SOURCE_ACTION_KEYS[index] && state.status === "done");
  } catch {
    return false;
  }
}

function assertReadMatches(before: SandyCorrectionRead, current: SandyCorrectionRead): void {
  if (before.beforeSnapshotSha256 !== current.beforeSnapshotSha256 ||
    !sameStableDatabaseIdentity(before.identity, current.identity) ||
    before.bindingDigest !== current.bindingDigest ||
    before.resultDigest !== current.resultDigest ||
    before.selectedToolJournalCount !== current.selectedToolJournalCount ||
    before.selectedToolJournalDigest !== current.selectedToolJournalDigest) {
    throw new Error("authoritative source snapshot changed before transaction writes");
  }
}
