import { existsSync, rmSync } from "node:fs";
import { assertPublicationClaim, releasePublicationClaim } from "./publication-claim.js";
import { assertExchangeCompatible, inspectPublicationRoot } from "./publication-integrity.js";
import { observeProjectLedgerSourceHead } from "./source-head.js";
import {
  assertSameTransaction,
  loadTransactionJournal,
  saveTransactionJournal,
} from "./transaction-journal.js";

export function promoteProjectLedgerPublication(publication, exchangeRoots) {
  let journal = requiredJournal(publication);
  if (journal.status === "observed") {
    assertHead(
      publication.candidateHead,
      inspectPublicationRoot(publication.canonicalRoot),
      "Observed Project Ledger publication is no longer active",
    );
    return receipt(publication, "observed");
  }
  assertPublicationClaim(publication.claimPath, publication);
  const active = observeProjectLedgerSourceHead(publication.canonicalRoot);
  if (sameHead(active, publication.candidateHead)) {
    inspectPublicationRoot(publication.canonicalRoot);
    journal = saveTransactionJournal(publication.journalPath, {
      ...journal,
      status: "promoted",
    });
  } else {
    assertLogicalHead(publication.base, active, "Project Ledger promotion lost its CAS base");
    if (!existsSync(publication.candidateRoot)) {
      throw new Error("Prepared Project Ledger candidate disappeared");
    }
    assertHead(
      publication.candidateHead,
      inspectPublicationRoot(publication.candidateRoot),
      "Prepared Project Ledger candidate changed",
    );
    assertExchangeCompatible(publication.candidateRoot, publication.canonicalRoot);
    saveTransactionJournal(publication.journalPath, { ...journal, status: "committing" });
    exchangeRoots(publication.candidateRoot, publication.canonicalRoot);
    assertHead(
      publication.candidateHead,
      inspectPublicationRoot(publication.canonicalRoot),
      "Project Ledger atomic exchange was not observable",
    );
    journal = saveTransactionJournal(publication.journalPath, {
      ...journal,
      status: "promoted",
    });
  }
  return receipt(publication, journal.status);
}

export function observeProjectLedgerPromotion(publication) {
  const journal = requiredJournal(publication);
  assertHead(
    publication.candidateHead,
    inspectPublicationRoot(publication.canonicalRoot),
    "Project Ledger promoted head is not active",
  );
  if (journal.status === "observed") {
    rmSync(publication.candidateRoot, { recursive: true, force: true });
    if (existsSync(publication.claimPath)) {
      releasePublicationClaim(publication.claimPath, publication);
    }
    return receipt(publication, "observed");
  }
  saveTransactionJournal(publication.journalPath, { ...journal, status: "observed" });
  rmSync(publication.candidateRoot, { recursive: true, force: true });
  releasePublicationClaim(publication.claimPath, publication);
  return receipt(publication, "observed");
}

function requiredJournal(publication) {
  const journal = loadTransactionJournal(publication.journalPath);
  if (!journal) throw new Error("Project Ledger publication journal is missing");
  assertSameTransaction(journal, publication);
  if (!sameHead(journal.candidateHead, publication.candidateHead)) {
    throw new Error("Project Ledger prepared candidate identity changed");
  }
  return journal;
}

function receipt(publication, status) {
  return {
    schema: "project-ledger.promotion-receipt.v1",
    publicationId: publication.publicationId,
    activeHead: publication.candidateHead,
    status,
  };
}

function sameHead(left, right) {
  return Boolean(left && right &&
    left.sourceSha256 === right.sourceSha256 &&
    left.sourceFileCount === right.sourceFileCount &&
    left.storageSha256 === right.storageSha256 &&
    left.storageEntryCount === right.storageEntryCount);
}

function sameLogicalHead(left, right) {
  return Boolean(left && right &&
    left.sourceSha256 === right.sourceSha256 &&
    left.sourceFileCount === right.sourceFileCount);
}

function assertHead(expected, actual, message) {
  if (!sameHead(expected, actual)) throw new Error(message);
}

function assertLogicalHead(expected, actual, message) {
  if (!sameLogicalHead(expected, actual)) throw new Error(message);
}
