import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { withDurableFileLock, writeJsonFileAtomic } from "../../../persistence/atomic-json-store.ts";
import type { ExactLedgerTargetPrecondition } from "./canonical-ledger-reader.ts";
import type { ProjectLedgerHead } from "./runtime-types.ts";

export type ProjectLedgerLogicalOperationKind =
  | "mutation_call" | "binding_revision" | "closeout_diagnostic" | "abandonment" | "legacy_import";
export type ProjectLedgerLogicalOperationIdentity = { kind: ProjectLedgerLogicalOperationKind; id: string };
export type ProjectLedgerEffectAttempt = {
  number: number;
  status: "admitted";
  requestSha256: string;
  publicationId: string;
  expectedBase: ProjectLedgerHead;
  targetPreconditions: ExactLedgerTargetPrecondition[];
};
type OccurrenceScope = {
  ledgerProjectId: string;
  ledgerRoot: string;
  operationIdentity: ProjectLedgerLogicalOperationIdentity;
};
export type ProjectLedgerEffectOccurrence = OccurrenceScope & {
  schema: "butler.btcc-project-ledger-effect-occurrence.v2";
  occurrenceId: string;
  status: "pending";
  attempts: ProjectLedgerEffectAttempt[];
};
type ExpectedOccurrence = OccurrenceScope & { requestSha256: string };
export type ProjectLedgerEffectOccurrenceAccessInput = ExpectedOccurrence & {
  butlerData: string;
  contentionAttempts?: number;
};
type AttemptContent = {
  expectedBase: ProjectLedgerHead;
  targetPreconditions: ExactLedgerTargetPrecondition[];
};
type AdmissionInput = ProjectLedgerEffectOccurrenceAccessInput & AttemptContent;

export class ProjectLedgerEffectConflictError extends Error {
  readonly code = "project_ledger_effect_occurrence_conflict";
  constructor(readonly occurrenceId: string) {
    super("The admitted Project Ledger effect occurrence already has different content");
    this.name = "ProjectLedgerEffectConflictError";
  }
}

export class ProjectLedgerEffectEvidenceUnsupportedError extends Error {
  readonly code = "project_ledger_effect_evidence_unsupported";
  constructor(readonly evidence: "legacy_v1" | "observed") {
    super(`Project Ledger effect evidence is outside admission scope: ${evidence}`);
    this.name = "ProjectLedgerEffectEvidenceUnsupportedError";
  }
}

export function admitProjectLedgerEffectOccurrence(input: AdmissionInput): ProjectLedgerEffectOccurrence {
  const expected = expectedOccurrence(input);
  const candidate = buildOccurrence(input, expected);
  return mutateOccurrence(input, candidate.occurrenceId, () => {
    const path = occurrenceFile(input.butlerData, candidate.occurrenceId);
    const stored = readStoredOccurrence(path);
    if (stored) {
      if (stored.ledgerRoot !== candidate.ledgerRoot ||
        stored.attempts[0]?.publicationId !== candidate.attempts[0]?.publicationId) {
        throw new ProjectLedgerEffectConflictError(candidate.occurrenceId);
      }
      return stored;
    }
    writeJsonFileAtomic(path, candidate);
    return candidate;
  });
}

export function readProjectLedgerEffectOccurrence(
  input: ProjectLedgerEffectOccurrenceAccessInput,
): ProjectLedgerEffectOccurrence | null {
  const expected = expectedOccurrence(input);
  return readStoredOccurrence(occurrenceFile(input.butlerData, deterministicOccurrenceId(expected)), expected);
}

export function appendProjectLedgerEffectAttempt(
  input: AdmissionInput & { afterAttemptNumber: number },
): ProjectLedgerEffectOccurrence {
  const expected = expectedOccurrence(input);
  const occurrenceId = deterministicOccurrenceId(expected);
  return mutateOccurrence(input, occurrenceId, () => {
    const path = occurrenceFile(input.butlerData, occurrenceId);
    const stored = readStoredOccurrence(path, expected);
    if (!stored) return invalid();
    if (stored.attempts.length !== input.afterAttemptNumber) {
      throw new ProjectLedgerEffectConflictError(occurrenceId);
    }
    const attempt = buildAttempt(stored.attempts.length + 1, input, expected, occurrenceId);
    const appended = { ...stored, attempts: [...stored.attempts, attempt] };
    writeJsonFileAtomic(path, appended);
    return appended;
  });
}
function mutateOccurrence(
  input: { butlerData: string; contentionAttempts?: number },
  occurrenceId: string,
  action: () => ProjectLedgerEffectOccurrence,
): ProjectLedgerEffectOccurrence {
  const storageRoot = join(resolve(input.butlerData), "runtime", "btcc-project-ledger-effects-v2");
  const attempts = input.contentionAttempts ?? 4;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 16) invalid();
  for (let index = 0; index < attempts; index += 1) {
    const result = withDurableFileLock({
      lockPath: join(storageRoot, "admission-locks", occurrenceId),
      lockRoot: resolve(input.butlerData),
      ownerId: `project-ledger-effect-admission:${process.pid}:${randomUUID()}`,
      busyTimeoutMs: 250,
      action(lease) {
        if (!lease.isOwned()) throw new Error("project_ledger_occurrence_lock_lost");
        return action();
      },
    });
    if (result) return result;
  }
  throw new Error("project_ledger_occurrence_admission_contended");
}

export function decodeProjectLedgerEffectOccurrence(
  value: unknown,
  expected: ExpectedOccurrence,
): ProjectLedgerEffectOccurrence {
  const object = record(value);
  rejectUnsupportedEvidence(object);
  exactKeys(object, OCCURRENCE_KEYS);
  if (object.schema !== "butler.btcc-project-ledger-effect-occurrence.v2" || object.status !== "pending") invalid();
  const scope = parseOccurrenceScope(object);
  const requested = expectedOccurrence(expected);
  if (scope.ledgerProjectId !== requested.ledgerProjectId || scope.ledgerRoot !== requested.ledgerRoot ||
    scope.operationIdentity.kind !== requested.operationIdentity.kind ||
    scope.operationIdentity.id !== requested.operationIdentity.id) invalid();
  const occurrenceId = sha(object.occurrenceId);
  if (occurrenceId !== deterministicOccurrenceId(scope)) invalid();
  if (!Array.isArray(object.attempts) || object.attempts.length === 0) invalid();
  return { ...scope, schema: object.schema, occurrenceId, status: "pending",
    attempts: object.attempts.map((entry, index) =>
      parseAttempt(entry, index + 1, scope, requested.requestSha256)) };
}
function buildOccurrence(input: AttemptContent, expected: ExpectedOccurrence): ProjectLedgerEffectOccurrence {
  const scope = parseOccurrenceScope(expected);
  const occurrenceId = deterministicOccurrenceId(scope);
  return {
    schema: "butler.btcc-project-ledger-effect-occurrence.v2",
    ...scope,
    occurrenceId,
    status: "pending",
    attempts: [buildAttempt(1, input, expected, occurrenceId)],
  };
}
function buildAttempt(
  number: number,
  input: AttemptContent,
  expected: ExpectedOccurrence,
  occurrenceId: string,
): ProjectLedgerEffectAttempt {
  const content = {
    number,
    requestSha256: expected.requestSha256,
    expectedBase: parseHead(input.expectedBase, expected.ledgerRoot),
    targetPreconditions: parsePreconditions(input.targetPreconditions, expected.ledgerProjectId),
  };
  return { ...content, status: "admitted",
    publicationId: deterministicPublicationId(occurrenceId, content) };
}
function readStoredOccurrence(
  path: string,
  expected?: ExpectedOccurrence,
): ProjectLedgerEffectOccurrence | null {
  if (!existsSync(path)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return invalid();
  }
  const object = record(value);
  rejectUnsupportedEvidence(object);
  const scope = parseOccurrenceScope(object);
  if (!Array.isArray(object.attempts)) invalid();
  const storedRequest = sha(record(object.attempts[0]).requestSha256);
  if (expected && storedRequest !== expected.requestSha256) {
    throw new ProjectLedgerEffectConflictError(deterministicOccurrenceId(expected));
  }
  return decodeProjectLedgerEffectOccurrence(value, expected ?? { ...scope, requestSha256: storedRequest });
}
function occurrenceFile(butlerData: string, occurrenceId: string): string {
  return join(resolve(butlerData), "runtime", "btcc-project-ledger-effects-v2", "occurrences", `${occurrenceId}.json`);
}
function rejectUnsupportedEvidence(value: Record<string, unknown>): void {
  if (value.schema === "butler.btcc-project-ledger-effect-occurrence.v1") {
    throw new ProjectLedgerEffectEvidenceUnsupportedError("legacy_v1");
  }
  if (value.status === "observed") throw new ProjectLedgerEffectEvidenceUnsupportedError("observed");
}
function expectedOccurrence(input: {
  ledgerProjectId: unknown;
  ledgerRoot: unknown;
  operationIdentity: unknown;
  requestSha256: unknown;
}): ExpectedOccurrence {
  return { ...parseOccurrenceScope(input), requestSha256: sha(input.requestSha256) };
}
function parseOccurrenceScope(input: {
  ledgerProjectId?: unknown;
  ledgerRoot?: unknown;
  operationIdentity?: unknown;
}): OccurrenceScope {
  const ledgerProjectId = text(input.ledgerProjectId);
  return { ledgerProjectId,
    ledgerRoot: canonicalLedgerRoot(input.ledgerRoot, ledgerProjectId),
    operationIdentity: parseIdentity(input.operationIdentity) };
}
function canonicalLedgerRoot(value: unknown, projectId: string): string {
  const requestedRoot = resolve(text(value));
  if (!existsSync(requestedRoot) || lstatSync(requestedRoot).isSymbolicLink()) invalid();
  const root = realpathSync(requestedRoot);
  const projectFile = join(root, "project.json");
  if (basename(root) !== safeProjectSegment(projectId) || !existsSync(projectFile) ||
    lstatSync(projectFile).isSymbolicLink()) invalid();
  try {
    const project = JSON.parse(readFileSync(projectFile, "utf8")) as { id?: unknown };
    if (text(project.id) !== projectId) invalid();
  } catch {
    invalid();
  }
  return root;
}
function parseAttempt(
  value: unknown,
  expectedNumber: number,
  scope: OccurrenceScope,
  requestSha256: string,
): ProjectLedgerEffectAttempt {
  const item = record(value);
  exactKeys(item, ATTEMPT_KEYS);
  if (item.status === "observed") throw new ProjectLedgerEffectEvidenceUnsupportedError("observed");
  if (item.number !== expectedNumber || item.status !== "admitted") invalid();
  const request = sha(item.requestSha256);
  if (request !== requestSha256) invalid();
  const content = {
    number: expectedNumber,
    requestSha256: request,
    expectedBase: parseHead(item.expectedBase, scope.ledgerRoot),
    targetPreconditions: parsePreconditions(item.targetPreconditions, scope.ledgerProjectId),
  };
  const publicationId = sha(item.publicationId);
  if (publicationId !== deterministicPublicationId(deterministicOccurrenceId(scope), content)) invalid();
  return { ...content, status: "admitted", publicationId };
}
function parsePreconditions(value: unknown, projectId: string): ExactLedgerTargetPrecondition[] {
  if (!Array.isArray(value) || value.length === 0) invalid();
  const keys = new Set<string>();
  return value.map((entry) => {
    const item = record(entry);
    exactKeys(item, PRECONDITION_KEYS);
    const base = { id: text(item.id), kind: text(item.kind), path: relativePath(item.path),
      parentId: item.parentId === null ? null : text(item.parentId) };
    if (!base.path.startsWith(`project-ledger/projects/${safeProjectSegment(projectId)}/`)) invalid();
    const key = `${base.kind}\0${base.id}\0${base.path}`;
    if (keys.has(key)) invalid();
    keys.add(key);
    if (item.state === "absent" && item.rawRecordSha256 === undefined) return { ...base, state: "absent" };
    if (item.state === "present") {
      return { ...base, state: "present", rawRecordSha256: sha(item.rawRecordSha256) };
    }
    return invalid();
  });
}
function parseHead(value: unknown, ledgerRoot: string): ProjectLedgerHead {
  const head = record(value);
  exactKeys(head, HEAD_KEYS);
  const requestedRoot = resolve(text(head.projectRoot));
  if (!existsSync(requestedRoot) || realpathSync(requestedRoot) !== ledgerRoot ||
    head.schema !== "butler.btcc-project-ledger-head.v1" ||
    !finiteCount(head.sourceFileCount) || !finiteCount(head.storageEntryCount)) invalid();
  return { schema: head.schema, projectRoot: ledgerRoot, sourceSha256: sha(head.sourceSha256),
    sourceFileCount: head.sourceFileCount, storageSha256: sha(head.storageSha256),
    storageEntryCount: head.storageEntryCount };
}
function deterministicOccurrenceId(scope: OccurrenceScope): string {
  return digestJson({ ledgerProjectId: scope.ledgerProjectId,
    operationKind: scope.operationIdentity.kind, operationId: scope.operationIdentity.id });
}
function deterministicPublicationId(
  occurrenceId: string,
  attempt: Omit<ProjectLedgerEffectAttempt, "status" | "publicationId">,
): string {
  return digestJson({ schema: "butler.btcc-project-ledger-effect-publication.v2", occurrenceId,
    attemptNumber: attempt.number, requestSha256: attempt.requestSha256,
    expectedBase: attempt.expectedBase, targetPreconditions: attempt.targetPreconditions });
}

const OCCURRENCE_KEYS = ["schema", "ledgerProjectId", "ledgerRoot", "operationIdentity", "occurrenceId", "status", "attempts"];
const ATTEMPT_KEYS = ["number", "status", "requestSha256", "publicationId", "expectedBase", "targetPreconditions"];
const PRECONDITION_KEYS = ["id", "kind", "path", "parentId", "state", "rawRecordSha256"];
const HEAD_KEYS = ["schema", "projectRoot", "sourceSha256", "sourceFileCount", "storageSha256", "storageEntryCount"];
function parseIdentity(value: unknown): ProjectLedgerLogicalOperationIdentity {
  const identity = record(value);
  exactKeys(identity, ["kind", "id"]);
  if (!isOperationKind(identity.kind)) invalid();
  return { kind: identity.kind, id: text(identity.id) };
}
function isOperationKind(value: unknown): value is ProjectLedgerLogicalOperationKind {
  return typeof value === "string" && [
    "mutation_call", "binding_revision", "closeout_diagnostic", "abandonment", "legacy_import",
  ].includes(value);
}
function exactKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid();
}
function record(value: unknown): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return invalid();
  return value;
}
function relativePath(value: unknown): string {
  const path = text(value);
  if (path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) invalid();
  return path;
}
function safeProjectSegment(value: string): string {
  return value.trim().toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 96);
}
function finiteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}
function sha(value: unknown): string {
  const hash = text(value);
  if (!/^[a-f0-9]{64}$/u.test(hash)) return invalid();
  return hash;
}
function invalid(): never {
  throw new Error("project_ledger_occurrence_invalid");
}
function digestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
