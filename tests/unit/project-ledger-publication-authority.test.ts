import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const sourceRoot = join(process.cwd(), "packages", "project-ledger", "src");

test("Project Ledger publication identity ignores non-authoritative metadata only", async () => {
  const project = mkdtempSync(join(tmpdir(), "project-ledger-publication-authority-"));
  const butlerData = join(project, ".butler-data");
  const previousButlerData = process.env.BUTLER_DATA;
  process.env.BUTLER_DATA = butlerData;
  try {
    writeFileSync(
      join(project, "package.json"),
      `${JSON.stringify({ name: "demo", private: true }, null, 2)}\n`,
      "utf8",
    );
    const { handle } = await importCore("commands.js");
    const transactions = await importCore("transactions/index.js");
    handle("init", [], { project, id: "demo", name: "Demo Project" });
    refreshDerivedLedger(handle, project);

    const canonicalRoot = join(butlerData, "project-ledger", "projects", "demo");
    const stagingRoot = join(butlerData, "runtime", "publication-test");
    const journalPath = join(stagingRoot, "journal.json");
    const publication = transactions.prepareProjectLedgerPublication({
      publicationId: "publication-metadata-authority",
      canonicalRoot,
      candidateRoot: join(stagingRoot, "candidate"),
      journalPath,
      expectedBase: transactions.observeProjectLedgerSourceHead(canonicalRoot),
      materialize(candidate: string) {
        createReference(handle, candidate, "REF-PUBLICATION", "Publication result");
      },
    });
    transactions.promoteProjectLedgerPublication(publication, exchangeRoots);

    makeLegacyHead(publication, journalPath);
    writeFileSync(join(canonicalRoot, ".DS_Store"), "finder changed\n", "utf8");
    mkdirSync(join(canonicalRoot, "references"), { recursive: true });
    writeFileSync(join(canonicalRoot, "references", ".DS_Store"), "nested changed\n", "utf8");
    expect(() => transactions.promoteProjectLedgerPublication(publication, exchangeRoots))
      .not.toThrow();
    expect(() => transactions.observeProjectLedgerPromotion(publication)).not.toThrow();

    const authoritative = transactions.prepareProjectLedgerPublication({
      publicationId: "publication-authoritative-drift",
      canonicalRoot,
      candidateRoot: join(stagingRoot, "candidate-authoritative"),
      journalPath: join(stagingRoot, "journal-authoritative.json"),
      expectedBase: transactions.observeProjectLedgerSourceHead(canonicalRoot),
      materialize(candidate: string) {
        createReference(handle, candidate, "REF-AUTHORITATIVE", "Authoritative result");
      },
    });
    transactions.promoteProjectLedgerPublication(authoritative, exchangeRoots);
    writeFileSync(join(canonicalRoot, "references", "ref-authoritative.md"), "corrupt\n", "utf8");
    expect(() => transactions.observeProjectLedgerPromotion(authoritative)).toThrow();
  } finally {
    if (previousButlerData === undefined) delete process.env.BUTLER_DATA;
    else process.env.BUTLER_DATA = previousButlerData;
    rmSync(project, { recursive: true, force: true });
  }
});

async function importCore(name: string): Promise<any> {
  return import(pathToFileURL(join(sourceRoot, name)).href);
}

function createReference(
  handle: (...args: any[]) => any,
  project: string,
  id: string,
  title: string,
): void {
  handle("record", ["create"], { project, kind: "reference", id, title });
  refreshDerivedLedger(handle, project);
}

function refreshDerivedLedger(handle: (...args: any[]) => any, project: string): void {
  for (const view of ["dashboard", "handoff", "roadmap"]) {
    handle("render", [view], { project, write: true });
  }
  handle("index", [], { project });
}

function exchangeRoots(left: string, right: string): void {
  const previous = `${right}.previous`;
  renameSync(right, previous);
  renameSync(left, right);
  renameSync(previous, left);
}

function makeLegacyHead(publication: any, journalPath: string): void {
  const legacyHead = { ...publication.candidateHead };
  delete legacyHead.storageAuthority;
  legacyHead.storageSha256 = "f".repeat(64);
  legacyHead.storageEntryCount += 2;
  publication.candidateHead = legacyHead;
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.candidateHead = legacyHead;
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
}
