import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { acquirePublicationClaim, assertPublicationClaim, releasePublicationClaim, publicationClaimPath } from "./publication-claim.js";
import { assertSameTransaction, loadTransactionJournal, saveTransactionJournal } from "./transaction-journal.js";
import { observeProjectLedgerRecordHead, recordPath, workDirectories } from "./record-snapshot.js";
import { refreshDerivedIndexRecords } from "../indexer.js";

/** Same publication owner/journal, with a sparse candidate instead of a root copy. */
export function prepareRecordPublication(input) {
  const expected = {
    schema: "project-ledger.publication-transaction.v1",
    publicationId: input.publicationId,
    canonicalRoot: input.canonicalRoot,
    candidateRoot: input.candidateRoot,
    journalPath: input.journalPath,
    claimPath: publicationClaimPath(input.journalPath, input.canonicalRoot),
    base: input.expectedBase,
  };
  const existing = loadTransactionJournal(input.journalPath);
  if (existing) {
    assertSameTransaction(existing, expected);
    if (existing.candidateHead) return prepared(existing);
  }
  saveTransactionJournal(input.journalPath, { ...expected, status: "claim_pending" });
  acquirePublicationClaim(expected.claimPath, expected);
  try {
    assertHead(input.expectedBase, observeProjectLedgerRecordHead(input.canonicalRoot, input.expectedBase.recordPaths));
    saveTransactionJournal(input.journalPath, { ...expected, status: "preparing" });
    rmSync(input.candidateRoot, { recursive: true, force: true });
    rmSync(`${input.candidateRoot}.before`, { recursive: true, force: true });
    mkdirSync(input.candidateRoot, { recursive: true });
    copyFileSync(join(input.canonicalRoot, "project.json"), join(input.candidateRoot, "project.json"));
    writeFileSync(join(input.candidateRoot, "ledger.jsonl"), "");
    for (const name of workDirectories(input.canonicalRoot)) mkdirSync(join(input.candidateRoot, "work", name), { recursive: true });
    for (const path of input.expectedBase.recordPaths) {
      const source = recordPath(input.canonicalRoot, path);
      if (!existsSync(source)) continue;
      for (const destination of [recordPath(input.candidateRoot, path), recordPath(`${input.candidateRoot}.before`, path)]) {
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(source, destination);
      }
    }
    input.materialize(input.candidateRoot);
    const candidateHead = observeProjectLedgerRecordHead(input.candidateRoot, input.expectedBase.recordPaths);
    return prepared(saveTransactionJournal(input.journalPath, { ...expected, candidateHead, status: "prepared" }));
  } catch (error) {
    rmSync(input.candidateRoot, { recursive: true, force: true });
    rmSync(`${input.candidateRoot}.before`, { recursive: true, force: true });
    rmSync(input.journalPath, { force: true });
    releasePublicationClaim(expected.claimPath, expected);
    throw error;
  }
}

export function promoteRecordPublication(publication) {
  let journal = requiredJournal(publication);
  assertPublicationClaim(publication.claimPath, publication);
  if (journal.status === "prepared") {
    assertHead(publication.base, observeProjectLedgerRecordHead(publication.canonicalRoot, publication.base.recordPaths));
    assertHead(publication.candidateHead, observeProjectLedgerRecordHead(publication.candidateRoot, publication.base.recordPaths));
    journal = saveTransactionJournal(publication.journalPath, { ...journal, status: "committing" });
  }
  if (journal.status === "committing") {
    for (const path of publication.base.recordPaths) {
      if (path === "project.json") continue;
      const source = recordPath(publication.candidateRoot, path);
      const target = recordPath(publication.canonicalRoot, path);
      const before = recordPath(`${publication.candidateRoot}.before`, path);
      const raw = existsSync(source) ? readFileSync(source) : null;
      const old = existsSync(before) ? readFileSync(before) : null;
      if ((raw && old && raw.equals(old)) || (!raw && !old)) continue;
      if (!raw) throw new Error("Record publication does not delete source records");
      if (existsSync(target) && readFileSync(target).equals(raw)) continue;
      mkdirSync(dirname(target), { recursive: true });
      const temporary = `${source}.next`;
      copyFileSync(source, temporary);
      renameSync(temporary, target);
    }
    assertHead(publication.candidateHead, observeProjectLedgerRecordHead(publication.canonicalRoot, publication.base.recordPaths));
    journal = saveTransactionJournal(publication.journalPath, { ...journal, status: "promoted" });
  }
  return { publicationId: publication.publicationId, status: journal.status };
}

export function observeRecordPublication(publication, beforeRelease) {
  const journal = requiredJournal(publication);
  assertHead(publication.candidateHead, observeProjectLedgerRecordHead(publication.canonicalRoot, publication.base.recordPaths));
  saveTransactionJournal(publication.journalPath, { ...journal, status: "observed" });
  // The index is a derived read model, never a prerequisite for Work success.
  try { refreshDerivedIndexRecords(publication.canonicalRoot, publication.base.recordPaths); }
  catch { /* Source mtimes leave the old/missing index visibly stale for on-demand rebuild. */ }
  beforeRelease?.();
  // The observed receipt is visible before any reader can select the new set.
  if (existsSync(publication.claimPath)) releasePublicationClaim(publication.claimPath, publication);
  rmSync(publication.candidateRoot, { recursive: true, force: true });
  rmSync(`${publication.candidateRoot}.before`, { recursive: true, force: true });
  return { publicationId: publication.publicationId, status: "observed" };
}

function requiredJournal(publication) {
  const journal = loadTransactionJournal(publication.journalPath);
  if (!journal) throw new Error("Project Ledger publication journal is missing");
  assertSameTransaction(journal, publication);
  return journal;
}

function prepared(journal) {
  return { ...journal, schema: "project-ledger.prepared-publication.v1" };
}

function assertHead(expected, actual) {
  if (expected.sourceSha256 !== actual.sourceSha256 || expected.sourceFileCount !== actual.sourceFileCount) {
    throw new Error("Project Ledger addressed records changed");
  }
}
