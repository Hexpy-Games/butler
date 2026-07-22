import { rmSync } from "node:fs";
import { copyDirectory } from "../fs.js";
import {
  acquirePublicationClaim,
  publicationClaimPath,
  releasePublicationClaim,
} from "./publication-claim.js";
import { assertExchangeCompatible, inspectPublicationRoot } from "./publication-integrity.js";
import { observeProjectLedgerSourceHead } from "./source-head.js";
import {
  assertSameTransaction,
  loadTransactionJournal,
  saveTransactionJournal,
} from "./transaction-journal.js";

export function prepareProjectLedgerPublication(input) {
  assertHead(input.expectedBase, observeProjectLedgerSourceHead(input.canonicalRoot));
  const expected = transactionIdentity(input);
  const existing = loadTransactionJournal(input.journalPath);
  if (existing) {
    assertSameTransaction(existing, expected);
    acquirePublicationClaim(expected.claimPath, expected);
    if (existing.status === "prepared" || existing.status === "committing" ||
      existing.status === "promoted" || existing.status === "observed") {
      return preparedFromJournal(existing);
    }
  } else {
    saveTransactionJournal(input.journalPath, { ...expected, status: "claim_pending" });
    try {
      acquirePublicationClaim(expected.claimPath, expected);
    } catch (error) {
      rmSync(input.journalPath, { force: true });
      throw error;
    }
  }
  try {
    saveTransactionJournal(input.journalPath, { ...expected, status: "preparing" });
    rmSync(input.candidateRoot, { recursive: true, force: true });
    copyDirectory(input.canonicalRoot, input.candidateRoot);
    assertExchangeCompatible(input.canonicalRoot, input.candidateRoot);
    input.materialize(input.candidateRoot);
    const candidateHead = inspectPublicationRoot(input.candidateRoot);
    const prepared = saveTransactionJournal(input.journalPath, {
      ...expected,
      candidateHead,
      status: "prepared",
    });
    return preparedFromJournal(prepared);
  } catch (error) {
    rmSync(input.candidateRoot, { recursive: true, force: true });
    rmSync(input.journalPath, { force: true });
    releasePublicationClaim(expected.claimPath, expected);
    throw error;
  }
}

export function abortProjectLedgerPublication(publication) {
  const journal = loadTransactionJournal(publication.journalPath);
  if (!journal) return;
  assertSameTransaction(journal, publication);
  if (!["preparing", "prepared"].includes(journal.status)) {
    throw new Error(`Project Ledger publication cannot abort from ${journal.status}`);
  }
  rmSync(publication.candidateRoot, { recursive: true, force: true });
  rmSync(publication.journalPath, { force: true });
  releasePublicationClaim(publication.claimPath, publication);
}

export function loadPreparedProjectLedgerPublication(input) {
  const journal = loadTransactionJournal(input.journalPath);
  if (!journal) throw new Error("Project Ledger publication journal is missing");
  assertSameTransaction(journal, transactionIdentity(input));
  if (!journal.candidateHead) throw new Error("Project Ledger publication is not prepared");
  return preparedFromJournal(journal);
}

function transactionIdentity(input) {
  return {
    schema: "project-ledger.publication-transaction.v1",
    publicationId: input.publicationId,
    canonicalRoot: input.canonicalRoot,
    candidateRoot: input.candidateRoot,
    journalPath: input.journalPath,
    claimPath: publicationClaimPath(input.journalPath, input.canonicalRoot),
    base: input.expectedBase,
  };
}

function preparedFromJournal(journal) {
  return {
    schema: "project-ledger.prepared-publication.v1",
    publicationId: journal.publicationId,
    canonicalRoot: journal.canonicalRoot,
    candidateRoot: journal.candidateRoot,
    journalPath: journal.journalPath,
    claimPath: journal.claimPath,
    base: journal.base,
    candidateHead: journal.candidateHead,
  };
}

function assertHead(expected, actual) {
  if (expected.projectRoot !== actual.projectRoot ||
    expected.sourceSha256 !== actual.sourceSha256 ||
    expected.sourceFileCount !== actual.sourceFileCount) {
    throw new Error("Project Ledger canonical head changed before preparation");
  }
}
