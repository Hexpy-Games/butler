import { existsSync, rmSync } from "node:fs";
import { exchangeCompleteRoots } from "../../../../../foundation/complete-root-commit/index.ts";
import { revalidateExactLedgerPreconditions } from "../canonical-ledger-reader.ts";
import type { ProjectLedgerEffectAttempt } from "../external-effect-occurrence.ts";
import type { ProjectLedgerCore } from "../project-ledger-core.ts";
import type { ProjectLedgerCorePublication, ProjectLedgerHead } from "../runtime-types.ts";
import {
  appliedEvidence,
  createObservedReceipt,
  exactClaimExists,
  publicationPaths,
  readPublicationJournal,
  readPublicationReceipt,
  sameHead,
  sameLogicalHead,
  writeNotAppliedReceipt,
  writeObservedReceipt,
  type AppliedPublicationEvidence,
  type PublicationJournal,
  type PublicationPaths,
} from "./evidence-codec.ts";

export type ProjectLedgerPublicationState =
  | { status: "ready" }
  | { status: "applied"; evidence: AppliedPublicationEvidence }
  | { status: "not_applied" }
  | { status: "uncertain"; message: string };
type ProjectLedgerAttemptOutcome = Exclude<ProjectLedgerPublicationState, { status: "ready" }>;

type PublicationInput = {
  core: ProjectLedgerCore;
  butlerData: string;
  ledgerRoot: string;
  occurrenceId: string;
  attempt: ProjectLedgerEffectAttempt;
};

type PublicationAttemptInput = PublicationInput & {
  observeHead(projectRoot: string, recordPaths?: string[]): Promise<ProjectLedgerHead>;
  materialize(candidateRoot: string): void;
  runPhase<T>(phase: "prepare" | "promote" | "observe_promotion", run: () => T): T;
};

const SAFE_UNCERTAIN_MESSAGE =
  "The Project Ledger publication state could not be verified safely.";

export async function reconcileProjectLedgerPublication(
  input: PublicationInput & {
    observeHead(projectRoot: string, recordPaths?: string[]): Promise<ProjectLedgerHead>;
  },
): Promise<ProjectLedgerPublicationState> {
  const paths = pathsFor(input);
  const receipt = readPublicationReceipt(paths.receiptPath, input);
  if (receipt) {
    if (receipt.status === "observed" && input.attempt.expectedBase.recordPaths) {
      const journal = readPublicationJournal(paths.journalPath, input, paths, false);
      if (journal) cleanupApplied(input, paths, journal);
    }
    return receipt.status === "not_applied"
      ? { status: "not_applied" }
      : { status: "applied", evidence: appliedEvidence(receipt) };
  }
  const journal = readPublicationJournal(paths.journalPath, input, paths);
  if (!journal) {
    if (existsSync(paths.candidateRoot) || exactClaimExists(input)) return uncertain();
    writeNotAppliedReceipt(paths.receiptPath, input);
    return { status: "not_applied" };
  }
  if (journal.status === "claim_pending" || journal.status === "preparing") {
    cleanupPreExchange(input, paths, journal);
    writeNotAppliedReceipt(paths.receiptPath, input);
    return { status: "not_applied" };
  }
  if (journal.status === "promoted" || journal.status === "observed") {
    return recordAppliedRecovery(input, paths, journal);
  }
  if (input.attempt.expectedBase.recordPaths && journal.status === "committing") return { status: "ready" };
  const active = await input.observeHead(input.ledgerRoot, input.attempt.expectedBase.recordPaths);
  const baseActive = sameLogicalHead(active, input.attempt.expectedBase);
  const candidateActive = sameHead(active, journal.candidateHead);
  if (candidateActive) return recordAppliedRecovery(input, paths, journal);
  if (journal.status === "committing" && !baseActive && !candidateActive) return uncertain();
  if (journal.status === "prepared" && !baseActive) {
    cleanupPreExchange(input, paths, journal);
    writeNotAppliedReceipt(paths.receiptPath, input);
    return { status: "not_applied" };
  }
  return { status: "ready" };
}

export async function applyProjectLedgerPublicationAttempt(
  input: PublicationAttemptInput,
): Promise<ProjectLedgerAttemptOutcome> {
  try {
    const resumed = input.attempt.expectedBase.recordPaths &&
      readPublicationJournal(pathsFor(input).journalPath, input, pathsFor(input))?.status === "committing";
    if (resumed) return {
      status: "applied", evidence: input.runPhase("prepare", () => publishProjectLedgerPublication(input)),
    };
    await revalidateExactLedgerPreconditions(input.ledgerRoot, input.attempt.targetPreconditions);
    const active = await input.observeHead(input.ledgerRoot, input.attempt.expectedBase.recordPaths);
    if (!sameLogicalHead(active, input.attempt.expectedBase)) {
      recordProjectLedgerPublicationNotApplied(input);
      return { status: "not_applied" };
    }
    return {
      status: "applied",
      evidence: input.runPhase("prepare", () => publishProjectLedgerPublication(input)),
    };
  } catch {
    const recovered = await reconcileProjectLedgerPublication(input);
    if (recovered.status !== "ready") return recovered;
    if (input.attempt.expectedBase.recordPaths &&
      readPublicationJournal(pathsFor(input).journalPath, input, pathsFor(input))?.status === "committing") return uncertain();
    recordProjectLedgerPublicationNotApplied(input);
    return { status: "not_applied" };
  }
}

function publishProjectLedgerPublication(input: PublicationAttemptInput): AppliedPublicationEvidence {
  const paths = pathsFor(input);
  const transaction = {
    publicationId: input.attempt.publicationId,
    canonicalRoot: input.ledgerRoot,
    candidateRoot: paths.candidateRoot,
    journalPath: paths.journalPath,
    expectedBase: input.attempt.expectedBase,
  };
  const existing = readPublicationJournal(paths.journalPath, input, paths);
  const prepared = existing
    ? input.core.loadPreparedProjectLedgerPublication(transaction) as ProjectLedgerCorePublication
    : input.core.prepareProjectLedgerPublication({
        ...transaction,
        materialize: input.materialize,
      }) as ProjectLedgerCorePublication;
  input.runPhase("promote", () =>
    input.core.promoteProjectLedgerPublication(prepared, exchangeCompleteRoots));
  input.runPhase("observe_promotion", () => input.core.observeProjectLedgerPromotion(prepared, () => {
    const journal = readPublicationJournal(paths.journalPath, input, paths);
    if (!journal) throw new Error("project_ledger_publication_evidence_invalid");
    writeObservedReceipt(paths.receiptPath, createObservedReceipt(input, journal));
  }));
  const journal = readPublicationJournal(paths.journalPath, input, paths);
  if (!journal) throw new Error("project_ledger_publication_evidence_invalid");
  const receipt = createObservedReceipt(input, journal);
  return appliedEvidence(receipt);
}

function recordProjectLedgerPublicationNotApplied(input: PublicationInput): void {
  const paths = pathsFor(input);
  const journal = readPublicationJournal(paths.journalPath, input, paths);
  if (journal && ["committing", "promoted", "observed"].includes(journal.status)) return;
  if (journal) cleanupPreExchange(input, paths, journal);
  else rmSync(paths.candidateRoot, { recursive: true, force: true });
  writeNotAppliedReceipt(paths.receiptPath, input);
}

function cleanupPreExchange(
  input: PublicationInput,
  paths: PublicationPaths,
  journal: PublicationJournal,
): void {
  rmSync(paths.candidateRoot, { recursive: true, force: true });
  if (journal.base.recordPaths) rmSync(`${paths.candidateRoot}.before`, { recursive: true, force: true });
  input.core.reconcilePublicationClaim(journal.claimPath, journal, false);
  rmSync(paths.journalPath, { force: true });
}

function cleanupApplied(
  input: PublicationInput,
  paths: PublicationPaths,
  journal: PublicationJournal,
): void {
  input.core.reconcilePublicationClaim(journal.claimPath, journal, false);
  rmSync(paths.candidateRoot, { recursive: true, force: true });
  if (journal.base.recordPaths) rmSync(`${paths.candidateRoot}.before`, { recursive: true, force: true });
}

function recordAppliedRecovery(
  input: PublicationInput,
  paths: PublicationPaths,
  journal: PublicationJournal,
): Extract<ProjectLedgerPublicationState, { status: "applied" }> {
  const observed = createObservedReceipt(input, journal);
  writeObservedReceipt(paths.receiptPath, observed);
  cleanupApplied(input, paths, journal);
  return { status: "applied", evidence: appliedEvidence(observed) };
}

function pathsFor(input: Pick<PublicationInput, "butlerData" | "attempt">): PublicationPaths {
  return publicationPaths({
    butlerData: input.butlerData,
    publicationId: input.attempt.publicationId,
  });
}

function uncertain(): Extract<ProjectLedgerPublicationState, { status: "uncertain" }> {
  return { status: "uncertain", message: SAFE_UNCERTAIN_MESSAGE };
}
