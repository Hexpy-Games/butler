import { digest, stableJson, type ContentRef } from "../core/index.ts";
import type { ManagedProgramState, WorkLedgerCommit } from "./contracts.ts";

type LedgerIdentity = { ledgerId: string; programId: string };
type LogicalManifest = {
  ledgerId: string;
  programId: string;
  manifestRevision: number;
  program: ManagedProgramState | null;
  contentHash?: string;
};

export type LogicalLedgerBundle = {
  ref: ContentRef;
  mutationId: string;
  ledgerId: string;
  baseManifestRef: ContentRef;
  baseManifestHash: string;
  nextManifest: LogicalManifest & { contentHash: string };
  appendedRecordRefs: ContentRef[];
  mutationSummaryHash: string;
};

export type LogicalLedgerRecord = {
  ref: ContentRef;
  sourceRef: ContentRef;
  semanticBytes: string;
};

export function ledgerRecordSha256(recordWithoutSha256: unknown): string {
  return prefixedHash("btcc:ledger-record:v1", recordWithoutSha256);
}

export function assertLogicalLedgerRecordBytes(
  ref: ContentRef,
  semanticBytes: string,
): void {
  let decoded: unknown;
  try {
    decoded = JSON.parse(semanticBytes);
  } catch {
    throw new Error(`Work Ledger logical record is not canonical JSON: ${ref.id}`);
  }
  if (!ref.id.startsWith("ledger-record:") || stableJson(decoded) !== semanticBytes ||
    ledgerRecordSha256(decoded) !== ref.sha256) {
    throw new Error(`Work Ledger logical record identity is invalid: ${ref.id}`);
  }
}

export function ledgerManifestContentHash(
  program: ManagedProgramState | null,
  identity: LedgerIdentity,
): string {
  return prefixedHash("btcc:ledger-manifest:v1", manifestWithoutHash(program, identity));
}

export function ledgerAttemptRef(input: {
  ledgerId: string;
  programId: string;
  turnId: string;
  expectedTurnRevision: number;
  taskRef: ContentRef;
  record: unknown;
}): ContentRef {
  const id = prefixedHash("btcc:attempt:v1", {
    ledgerId: input.ledgerId,
    programId: input.programId,
    turnId: input.turnId,
    expectedTurnRevision: input.expectedTurnRevision,
    taskRef: input.taskRef,
  });
  return {
    id,
    sha256: ledgerRecordSha256({ ref: { id }, record: input.record }),
  };
}

export function ledgerMutationId(input: {
  commit: Omit<WorkLedgerCommit, "mutationId">;
  baseManifestHash: string;
}): string {
  const identity = ledgerIdentityOf(input.commit);
  return prefixedHash("btcc:ledger-mutation:v1", {
    ...identity,
    turnId: input.commit.turnId,
    expectedTurnRevision: input.commit.expectedTurnRevision,
    eventId: ledgerEventId(input.commit.mutation.kind, input.commit.mutation),
    submissionSha256: digest(stableJson(input.commit.mutation)),
    baseManifestRevision: baseRevisionOf(input.commit),
    baseManifestHash: input.baseManifestHash,
  });
}

export function createLogicalLedgerBundle(input: {
  commit: WorkLedgerCommit;
  previous: ManagedProgramState | null;
  next: ManagedProgramState;
}): LogicalLedgerBundle {
  const identity = ledgerIdentityOf(input.commit);
  const baseManifestHash = ledgerManifestContentHash(input.previous, identity);
  assertLogicalLedgerMutationId(input.commit, input.previous);
  const nextManifestWithoutHash = manifestWithoutHash(input.next, identity);
  const nextManifestContentHash = prefixedHash(
    "btcc:ledger-manifest:v1",
    nextManifestWithoutHash,
  );
  const nextManifest = { ...nextManifestWithoutHash, contentHash: nextManifestContentHash };
  const appendedRecordRefs = logicalLedgerRecords(
    input.commit.mutation,
    input.previous,
  ).map((record) => record.ref);
  const statusChanges = changedStatuses(input.previous, input.next);
  const mutationId = ledgerMutationId({
    commit: {
      turnId: input.commit.turnId,
      expectedTurnRevision: input.commit.expectedTurnRevision,
      mutation: input.commit.mutation,
    },
    baseManifestHash,
  });
  const mutationSummaryHash = prefixedHash("btcc:ledger-summary:v1", {
    appendedRecordRefs,
    statusChanges,
    nextManifestRevision: input.next.manifestRevision,
    nextManifestContentHash,
  });
  const bundleBody = {
    mutationId,
    ledgerId: identity.ledgerId,
    baseManifestRef: manifestRef(baseRevisionOf(input.commit), baseManifestHash),
    baseManifestHash,
    nextManifest,
    appendedRecordRefs,
    mutationSummaryHash,
  };
  const bundleHash = prefixedHash("btcc:ledger-bundle:v1", bundleBody);
  return {
    ref: { id: `ledger-bundle:${bundleHash}`, sha256: bundleHash },
    ...bundleBody,
  };
}

export function assertLogicalLedgerMutationId(
  commit: WorkLedgerCommit,
  previous: ManagedProgramState | null,
): void {
  const expected = ledgerMutationId({
    commit: {
      turnId: commit.turnId,
      expectedTurnRevision: commit.expectedTurnRevision,
      mutation: commit.mutation,
    },
    baseManifestHash: ledgerManifestContentHash(previous, ledgerIdentityOf(commit)),
  });
  if (commit.mutationId !== expected) {
    throw new Error("Work Ledger commit mutationId does not match its logical boundary");
  }
}

export function logicalLedgerRecords(
  mutation: unknown,
  previous: ManagedProgramState | null,
): LogicalLedgerRecord[] {
  const previousRecords = new Set(collectRecords(previous).map((record) => refKey(record.ref)));
  return collectRecords(mutation)
    .filter((record) => !previousRecords.has(refKey(record.ref)))
    .sort((left, right) => compareRefs(left.ref, right.ref));
}

function manifestWithoutHash(
  program: ManagedProgramState | null,
  identity: LedgerIdentity,
): LogicalManifest {
  return {
    ledgerId: identity.ledgerId,
    programId: identity.programId,
    manifestRevision: program?.manifestRevision ?? 0,
    program,
  };
}

function manifestRef(revision: number, hash: string): ContentRef {
  return { id: `ledger-manifest:${revision}:${hash}`, sha256: hash };
}

function ledgerIdentityOf(commit: Omit<WorkLedgerCommit, "mutationId">): LedgerIdentity {
  const mutation = commit.mutation;
  if (mutation.kind === "bind_program") {
    return {
      ledgerId: mutation.product.authority.managedBinding.ledgerId,
      programId: mutation.product.authority.managedBinding.programId,
    };
  }
  if (mutation.kind === "install_reviewed_plan") {
    return { ledgerId: mutation.product.candidate.ledgerId, programId: mutation.product.candidate.programId };
  }
  return { ledgerId: mutation.cursor.ledgerId, programId: mutation.cursor.programId };
}

function baseRevisionOf(commit: Omit<WorkLedgerCommit, "mutationId">): number {
  const mutation = commit.mutation;
  if (mutation.kind === "bind_program") {
    return mutation.product.authority.managedBinding.expectedManifestRevision;
  }
  if (mutation.kind === "install_reviewed_plan") return mutation.product.candidate.observedManifestRevision;
  return mutation.cursor.expectedManifestRevision;
}

function ledgerEventId(kind: string, mutation: unknown): string {
  return digest(`btcc:ledger-event:v1\0${kind}\0${digest(stableJson(mutation))}`);
}

function collectRecords(value: unknown): LogicalLedgerRecord[] {
  const records = new Map<string, LogicalLedgerRecord>();
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) return item.forEach(visit);
    if (!item || typeof item !== "object") return;
    const record = item as Record<string, unknown>;
    if (typeof record.recordKind === "string" &&
      typeof record.semanticBytes === "string") return;
    if (isContentRef(record.ref)) {
      const sourceRef = record.ref;
      const { ref: _sourceRef, ...semantic } = record;
      const logicalId = `ledger-record:${sourceRef.id}`;
      const logicalBody = { ref: { id: logicalId }, sourceId: sourceRef.id, record: semantic };
      const logicalRecord = {
        ref: { id: logicalId, sha256: ledgerRecordSha256(logicalBody) },
        sourceRef,
        semanticBytes: stableJson(logicalBody),
      };
      const prior = records.get(logicalId);
      if (prior && prior.semanticBytes !== logicalRecord.semanticBytes) {
        throw new Error(`Work Ledger logical record identity collision: ${sourceRef.id}`);
      }
      records.set(logicalId, logicalRecord);
    }
    Object.values(record).forEach(visit);
  };
  visit(value);
  return [...records.values()];
}

function changedStatuses(previous: ManagedProgramState | null, next: ManagedProgramState) {
  const before = statusMap(previous);
  return [...statusMap(next)]
    .filter(([key, status]) => before.get(key) !== status)
    .map(([subjectRef, to]) => ({ subjectRef, from: before.get(subjectRef) ?? null, to }))
    .sort((left, right) => left.subjectRef.localeCompare(right.subjectRef));
}

function statusMap(program: ManagedProgramState | null): Map<string, string> {
  const statuses = new Map<string, string>();
  if (!program) return statuses;
  statuses.set(`program:${program.programId}`, program.planningState);
  if (program.planningState === "reviewed") {
    program.works.forEach((work) => statuses.set(`work:${work.work.ref.id}`, work.status));
    program.tasks.forEach((task) => statuses.set(`task:${task.task.ref.id}`, task.status));
  }
  return statuses;
}

function prefixedHash(prefix: string, value: unknown): string {
  return digest(`${prefix}\0${stableJson(value)}`);
}

function refKey(ref: ContentRef): string {
  return `${ref.id}\0${ref.sha256}`;
}

function compareRefs(left: ContentRef, right: ContentRef): number {
  return refKey(left).localeCompare(refKey(right));
}

function isContentRef(value: unknown): value is ContentRef {
  return Boolean(value && typeof value === "object" &&
    typeof (value as ContentRef).id === "string" &&
    typeof (value as ContentRef).sha256 === "string");
}
