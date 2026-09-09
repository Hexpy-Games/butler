import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export function recordPath(root, path) {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Invalid publication record path");
  let cursor = root;
  for (const part of rel.split(/[\\/]/u)) {
    cursor = join(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error("Publication record is a symlink");
  }
  return target;
}

/** A head over addressed records, not all historical Project data. */
export function observeProjectLedgerRecordHead(root, recordPaths) {
  const paths = [...new Set(["project.json", ...recordPaths])].sort();
  const hash = createHash("sha256");
  let present = 0;
  for (const path of paths) {
    const file = recordPath(root, path);
    const raw = existsSync(file) ? readFileSync(file) : null;
    hash.update(JSON.stringify([path, raw?.toString("base64") ?? null]));
    if (raw) present += 1;
  }
  // New Work admission must also notice a concurrently created session head.
  hash.update(JSON.stringify(workDirectories(root)));
  const digest = hash.digest("hex");
  return {
    schema: "project-ledger.source-head.v1",
    storageAuthority: "project-ledger-record-set-v1",
    projectRoot: root,
    sourceSha256: digest,
    sourceFileCount: present,
    storageSha256: digest,
    storageEntryCount: present,
    recordPaths: paths,
  };
}

export function workDirectories(root) {
  const path = join(root, "work");
  return existsSync(path) ? readdirSync(path, { withFileTypes: true })
    .filter((item) => item.isDirectory()).map((item) => item.name).sort() : [];
}

export function publicationReadVersion(root) {
  const claim = readOptional(claimPath(root));
  if (!claim) return "";
  const value = JSON.parse(claim);
  return claim + (value.journalPath ? readOptional(value.journalPath) ?? "" : "");
}

/** Until receipt publication releases the claim, readers see the before-image set. */
export function readCommittedProjectLedgerRecords(root, paths) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const version = publicationReadVersion(root);
    try {
      const claimText = readOptional(claimPath(root));
      const claim = claimText ? JSON.parse(claimText) : null;
      const journalText = claim?.journalPath ? readOptional(claim.journalPath) : null;
      const journal = journalText ? JSON.parse(journalText) : null;
      const before = journal?.base?.recordPaths &&
        ["committing", "promoted", "observed"].includes(journal.status);
      const readSet = () => (typeof paths === "function" ? paths() : paths).map((path) => {
        const source = before && journal.base.recordPaths.includes(path)
          ? recordPath(`${journal.candidateRoot}.before`, path)
          : recordPath(root, path);
        return { path, raw: readOptional(source) };
      });
      const records = readSet();
      // A complete publication can acquire and release its claim between reads.
      // Compare addressed bytes too; equal empty claims alone are not a snapshot.
      if (version === publicationReadVersion(root) &&
        JSON.stringify(records) === JSON.stringify(readSet()) &&
        version === publicationReadVersion(root)) return records;
    } catch (error) {
      if (version === publicationReadVersion(root)) throw error;
    }
  }
  throw new Error("Project Ledger changed during record read");
}

function claimPath(root) {
  return join(dirname(root), ".project-ledger-locks", `${basename(root)}.lock`);
}

function readOptional(path) {
  try { return readFileSync(path, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
