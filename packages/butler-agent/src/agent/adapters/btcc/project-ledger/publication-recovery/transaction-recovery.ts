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
  observeHead(projectRoot: string): Promise<ProjectLedgerHead>;
  materialize(candidateRoot: string): void;
  runPhase<T>(phase: "prepare" | "promote" | "observe_promotion", run: () => T): T;
};

const SAFE_UNCERTAIN_MESSAGE =
  "The Project Ledger publication state could not be verified safely.";

export async function reconcileProjectLedgerPublication(
  input: PublicationInput & {
    observeHead(projectRoot: string): Promise<ProjectLedgerHead>;
  },
): Promise<ProjectLedgerPublicationState> {
  const paths = pathsFor(input);
  const receipt = readPublicationReceipt(paths.receiptPath, input);
  if (receipt) {
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
  const active = await input.observeHead(input.ledgerRoot);
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
    await revalidateExactLedgerPreconditions(input.ledgerRoot, input.attempt.targetPreconditions);
    const active = await input.observeHead(input.ledgerRoot);
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
  input.runPhase("observe_promotion", () => input.core.observeProjectLedgerPromotion(prepared));
  const journal = readPublicationJournal(paths.journalPath, input, paths);
  if (!journal) throw new Error("project_ledger_publication_evidence_invalid");
  const receipt = createObservedReceipt(input, journal);
  writeObservedReceipt(paths.receiptPath, receipt);
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
  input.core.reconcilePublicationClaim(journal.claimPath, journal, false);
  rmSync(paths.journalPath, { force: true });
}

function cleanupApplied(
  input: PublicationInput,
  paths: PublicationPaths,
  journal: PublicationJournal,
): void {
  rmSync(paths.candidateRoot, { recursive: true, force: true });
  input.core.reconcilePublicationClaim(journal.claimPath, journal, false);
}

function recordAppliedRecovery(
  input: PublicationInput,
  paths: PublicationPaths,
  journal: PublicationJournal,
): Extract<ProjectLedgerPublicationState, { status: "applied" }> {
  const observed = createObservedReceipt(input, journal);
  cleanupApplied(input, paths, journal);
  writeObservedReceipt(paths.receiptPath, observed);
  return { status: "applied", evidence: appliedEvidence(observed) };
}

function pathsFor(input: Pick<PublicationInput, "butlerData" | "attempt">): PublicationPaths {
  return publicationPaths({
    butlerData: input.butlerData,
    publicationId: input.attempt.publicationId,
  });
}

function uncertain(): ProjectLedgerPublicationState {
  return { status: "uncertain", message: SAFE_UNCERTAIN_MESSAGE };
}
