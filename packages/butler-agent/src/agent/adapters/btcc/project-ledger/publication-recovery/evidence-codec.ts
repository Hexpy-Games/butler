import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { writeJsonFileAtomic } from "../../../../persistence/atomic-json-store.ts";
import type { ProjectLedgerEffectAttempt } from "../external-effect-occurrence.ts";
import type { ProjectLedgerHead } from "../runtime-types.ts";

export type AppliedPublicationEvidence = {
  publicationId: string;
  attemptNumber: number;
  baseHead: ProjectLedgerHead;
  candidateHead: ProjectLedgerHead;
  promotionStatus: "promoted";
  observationStatus: "observed";
};

export type PublicationPaths = {
  candidateRoot: string;
  journalPath: string;
  receiptPath: string;
};

export type StoredReceipt = {
  schema: "butler.btcc-project-ledger-publication-receipt.v1";
  occurrenceId: string;
  attemptNumber: number;
  requestSha256: string;
  publicationId: string;
  status: "observed" | "not_applied";
  baseHead: ProjectLedgerHead;
  candidateHead?: ProjectLedgerHead;
};

export type PublicationJournal = {
  schema: "project-ledger.publication-transaction.v1";
  publicationId: string;
  canonicalRoot: string;
  candidateRoot: string;
  journalPath: string;
  claimPath: string;
  base: ProjectLedgerHead;
  status: "claim_pending" | "preparing" | "prepared" | "committing" | "promoted" | "observed";
  candidateHead?: ProjectLedgerHead;
};

type EvidenceInput = {
  ledgerRoot: string;
  occurrenceId: string;
  attempt: ProjectLedgerEffectAttempt;
};

export function publicationPaths(input: {
  butlerData: string;
  publicationId: string;
}): PublicationPaths {
  const root = join(resolve(input.butlerData), "runtime", "btcc-project-ledger-effects-v2");
  return {
    candidateRoot: join(root, "candidates", input.publicationId),
    journalPath: join(root, "journals", `${input.publicationId}.json`),
    receiptPath: join(root, "receipts", `${input.publicationId}.json`),
  };
}

export function readPublicationReceipt(path: string, input: EvidenceInput): StoredReceipt | null {
  if (!existsSync(path)) return null;
  const value = readJson(path);
  exactKeys(value, [
    "schema", "occurrenceId", "attemptNumber", "requestSha256", "publicationId",
    "status", "baseHead", "candidateHead",
  ]);
  if (
    value.schema !== "butler.btcc-project-ledger-publication-receipt.v1" ||
    value.occurrenceId !== input.occurrenceId ||
    value.attemptNumber !== input.attempt.number ||
    value.requestSha256 !== input.attempt.requestSha256 ||
    value.publicationId !== input.attempt.publicationId ||
    !["observed", "not_applied"].includes(String(value.status))
  ) invalidEvidence();
  const baseHead = decodeStoredHead(value.baseHead, input.ledgerRoot, "normalized");
  if (!sameHead(baseHead, input.attempt.expectedBase)) invalidEvidence();
  const candidateHead = value.status === "observed"
    ? decodeStoredHead(value.candidateHead, input.ledgerRoot, "normalized")
    : undefined;
  if (value.status === "not_applied" && value.candidateHead !== undefined) invalidEvidence();
  return {
    schema: "butler.btcc-project-ledger-publication-receipt.v1",
    occurrenceId: input.occurrenceId,
    attemptNumber: input.attempt.number,
    requestSha256: input.attempt.requestSha256,
    publicationId: input.attempt.publicationId,
    status: value.status as StoredReceipt["status"],
    baseHead,
    ...(candidateHead ? { candidateHead } : {}),
  };
}

export function readPublicationJournal(
  path: string,
  input: EvidenceInput,
  paths: PublicationPaths,
): PublicationJournal | null {
  if (!existsSync(path)) return null;
  const value = readJson(path);
  exactKeys(value, [
    "schema", "publicationId", "canonicalRoot", "candidateRoot", "journalPath",
    "claimPath", "base", "candidateHead", "status",
  ]);
  if (
    value.schema !== "project-ledger.publication-transaction.v1" ||
    value.publicationId !== input.attempt.publicationId ||
    value.canonicalRoot !== input.ledgerRoot ||
    value.candidateRoot !== paths.candidateRoot ||
    value.journalPath !== paths.journalPath ||
    !JOURNAL_STATUSES.includes(String(value.status))
  ) invalidEvidence();
  if (value.claimPath !== canonicalClaimPath(input.ledgerRoot)) invalidEvidence();
  validateClaimIfPresent(input);
  const base = decodeStoredHead(value.base, input.ledgerRoot, "normalized");
  if (!sameHead(base, input.attempt.expectedBase)) invalidEvidence();
  const needsCandidate = CANDIDATE_STATUSES.includes(String(value.status));
  const candidateHead = needsCandidate
    ? decodeStoredHead(value.candidateHead, paths.candidateRoot, "core", input.ledgerRoot)
    : undefined;
  if (!needsCandidate && value.candidateHead !== undefined) invalidEvidence();
  return {
    schema: "project-ledger.publication-transaction.v1",
    publicationId: input.attempt.publicationId,
    canonicalRoot: input.ledgerRoot,
    candidateRoot: paths.candidateRoot,
    journalPath: paths.journalPath,
    claimPath: canonicalClaimPath(input.ledgerRoot),
    base,
    status: value.status as PublicationJournal["status"],
    ...(candidateHead ? { candidateHead } : {}),
  };
}

export function writeNotAppliedReceipt(
  path: string,
  input: Pick<EvidenceInput, "occurrenceId" | "attempt">,
): void {
  writeJsonFileAtomic(path, {
    schema: "butler.btcc-project-ledger-publication-receipt.v1",
    occurrenceId: input.occurrenceId,
    attemptNumber: input.attempt.number,
    requestSha256: input.attempt.requestSha256,
    publicationId: input.attempt.publicationId,
    status: "not_applied",
    baseHead: input.attempt.expectedBase,
  } satisfies StoredReceipt);
}

export function createObservedReceipt(
  input: Pick<EvidenceInput, "occurrenceId" | "attempt">,
  journal: PublicationJournal,
): StoredReceipt {
  return {
    schema: "butler.btcc-project-ledger-publication-receipt.v1",
    occurrenceId: input.occurrenceId,
    attemptNumber: input.attempt.number,
    requestSha256: input.attempt.requestSha256,
    publicationId: input.attempt.publicationId,
    status: "observed",
    baseHead: input.attempt.expectedBase,
    candidateHead: journal.candidateHead ?? invalidEvidence(),
  };
}

export function writeObservedReceipt(path: string, receipt: StoredReceipt): void {
  writeJsonFileAtomic(path, receipt);
}

export function appliedEvidence(receipt: StoredReceipt): AppliedPublicationEvidence {
  if (!receipt.candidateHead) return invalidEvidence();
  return {
    publicationId: receipt.publicationId,
    attemptNumber: receipt.attemptNumber,
    baseHead: { ...receipt.baseHead },
    candidateHead: { ...receipt.candidateHead },
    promotionStatus: "promoted",
    observationStatus: "observed",
  };
}

export function exactClaimExists(input: Pick<EvidenceInput, "ledgerRoot" | "attempt">): boolean {
  const claimPath = canonicalClaimPath(input.ledgerRoot);
  if (!existsSync(claimPath)) return false;
  const value = readJson(claimPath);
  exactKeys(value, ["schema", "claimId", "publicationId", "canonicalRoot", "baseSha256"]);
  if (
    value.schema !== "project-ledger.publication-claim.v1" ||
    value.claimId !== input.attempt.publicationId ||
    value.publicationId !== input.attempt.publicationId ||
    value.canonicalRoot !== input.ledgerRoot ||
    value.baseSha256 !== input.attempt.expectedBase.sourceSha256 ||
    !isSha(value.baseSha256)
  ) invalidEvidence();
  return true;
}

export function sameLogicalHead(left: ProjectLedgerHead, right: ProjectLedgerHead): boolean {
  return left.projectRoot === right.projectRoot &&
    left.sourceSha256 === right.sourceSha256 &&
    left.sourceFileCount === right.sourceFileCount;
}

export function sameHead(
  left: ProjectLedgerHead | undefined,
  right: ProjectLedgerHead | undefined,
): boolean {
  return Boolean(left && right &&
    left.sourceSha256 === right.sourceSha256 &&
    left.sourceFileCount === right.sourceFileCount &&
    left.storageSha256 === right.storageSha256 &&
    left.storageEntryCount === right.storageEntryCount);
}

function validateClaimIfPresent(input: Pick<EvidenceInput, "ledgerRoot" | "attempt">): void {
  exactClaimExists(input);
}

function canonicalClaimPath(ledgerRoot: string): string {
  return join(dirname(ledgerRoot), ".project-ledger-locks", `${basename(ledgerRoot)}.lock`);
}

function decodeStoredHead(
  value: unknown,
  storedRoot: string,
  format: "normalized" | "core",
  normalizedRoot = storedRoot,
): ProjectLedgerHead {
  const head = record(value);
  exactKeys(head, format === "core" ? CORE_HEAD_KEYS : NORMALIZED_HEAD_KEYS);
  const schema = format === "core"
    ? "project-ledger.source-head.v1"
    : "butler.btcc-project-ledger-head.v1";
  if (
    head.schema !== schema || head.projectRoot !== storedRoot ||
    (format === "core" && head.storageAuthority !== "project-ledger-authoritative-v2") ||
    !isSha(head.sourceSha256) || !isSha(head.storageSha256) ||
    !finiteCount(head.sourceFileCount) || !finiteCount(head.storageEntryCount)
  ) invalidEvidence();
  return {
    schema: "butler.btcc-project-ledger-head.v1",
    projectRoot: normalizedRoot,
    sourceSha256: head.sourceSha256,
    sourceFileCount: head.sourceFileCount,
    storageSha256: head.storageSha256,
    storageEntryCount: head.storageEntryCount,
  };
}

const NORMALIZED_HEAD_KEYS = [
  "schema", "projectRoot", "sourceSha256", "sourceFileCount", "storageSha256", "storageEntryCount",
];
const CORE_HEAD_KEYS = ["schema", "storageAuthority", ...NORMALIZED_HEAD_KEYS.slice(1)];
const JOURNAL_STATUSES = ["claim_pending", "preparing", "prepared", "committing", "promoted", "observed"];
const CANDIDATE_STATUSES = ["prepared", "committing", "promoted", "observed"];

function isSha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function finiteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function exactKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalidEvidence();
}

function readJson(path: string): Record<string, unknown> {
  try {
    return record(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return invalidEvidence();
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || Array.isArray(value) || typeof value !== "object") return invalidEvidence();
  return value as Record<string, unknown>;
}

function invalidEvidence(): never {
  throw new Error("project_ledger_publication_evidence_invalid");
}
