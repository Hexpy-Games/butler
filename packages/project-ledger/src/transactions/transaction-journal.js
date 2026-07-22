import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ensureDir } from "../fs.js";

export function loadTransactionJournal(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

export function saveTransactionJournal(path, value) {
  ensureDir(dirname(path));
  const temporary = `${path}.next`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
  return value;
}

export function assertSameTransaction(journal, expected) {
  for (const key of [
    "publicationId",
    "canonicalRoot",
    "candidateRoot",
    "journalPath",
    "claimPath",
  ]) {
    if (journal[key] !== expected[key]) {
      throw new Error(`Project Ledger transaction changed ${key}`);
    }
  }
  if (journal.base.projectRoot !== expected.base.projectRoot ||
    journal.base.sourceSha256 !== expected.base.sourceSha256 ||
    journal.base.sourceFileCount !== expected.base.sourceFileCount) {
    throw new Error("Project Ledger transaction changed its canonical base");
  }
}
