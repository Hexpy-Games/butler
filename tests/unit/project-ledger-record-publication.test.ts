import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

test("changed-record publication recovers a partial multi-Work write without exposing it", async () => {
  const core = (name: string) => import(pathToFileURL(join(process.cwd(), "packages/project-ledger/src", name)).href);
  const { observeProjectLedgerRecordHead, readCommittedProjectLedgerRecords,
    prepareProjectLedgerPublication, loadPreparedProjectLedgerPublication,
    promoteProjectLedgerPublication, observeProjectLedgerPromotion } = await core("transactions/index.js");
  const { buildIndex, writeIndex, loadIndex, readIndex } = await core("indexer.js");
  const { showRecord } = await core("record-commands.js");
  const root = mkdtempSync(join(tmpdir(), "ledger-record-publication-"));
  try {
    const canonicalRoot = join(root, "projects", "demo");
    const candidateRoot = join(root, "candidates", "one");
    const journalPath = join(root, "journals", "one.json");
    const write = (base: string, path: string, raw: string) => {
      mkdirSync(dirname(join(base, path)), { recursive: true });
      writeFileSync(join(base, path), raw);
    };
    write(canonicalRoot, "project.json", JSON.stringify({ id: "demo", name: "Demo", status: "active" }));
    write(canonicalRoot, "ledger.jsonl", "");
    const work = (id: string, title: string) => `---\nid: ${id}\nkind: work\nstatus: in_progress\ntitle: ${title}\n---\n\n${title}\n`;
    const oldHead = work("old", "Old current head");
    const oldRetired = work("old", "Old retired head");
    const newHead = work("new", "New current head");
    write(canonicalRoot, "work/old/work.md", oldHead);
    write(canonicalRoot, "references/history.md", "history stays untouched");
    const historyTime = statSync(join(canonicalRoot, "references/history.md")).mtimeMs;
    const paths = ["work/old/work.md", "work/new/work.md", "references/binding.md"];
    writeIndex(canonicalRoot);
    expect(readIndex(canonicalRoot).records.some((record: { id: string }) => record.id === "history")).toBe(true);
    const expectCommittedOldIndex = () => {
      for (const read of [buildIndex, loadIndex, readIndex]) {
        expect(read(canonicalRoot).records.filter((record: { kind: string }) => record.kind === "work")
          .map((record: { id: string; title: string }) => [record.id, record.title]))
          .toEqual([["old", "Old current head"]]);
      }
      expect(showRecord(canonicalRoot, { kind: "work", id: "old", body: true }))
        .toMatchObject({ title: "Old current head", body: "Old current head\n" });
    };
    const transaction = {
      publicationId: "record-publication-one", canonicalRoot, candidateRoot, journalPath,
      expectedBase: observeProjectLedgerRecordHead(canonicalRoot, paths),
    };
    const publication = prepareProjectLedgerPublication({
      ...transaction,
      materialize(candidate: string) {
        write(candidate, paths[0]!, oldRetired);
        write(candidate, paths[1]!, newHead);
        write(candidate, paths[2]!, "new Work binding");
      },
    });
    expect(existsSync(join(candidateRoot, "references/history.md"))).toBe(false);
    expect(readCommittedProjectLedgerRecords(canonicalRoot, paths).map((item: { raw: string | null }) => item.raw))
      .toEqual([oldHead, null, null]);

    // Exact interrupted boundary: journal committed to roll-forward, only the first file applied.
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    writeFileSync(journalPath, JSON.stringify({ ...journal, status: "committing" }));
    copyFileSync(join(candidateRoot, paths[0]!), join(canonicalRoot, paths[0]!));
    expect(readCommittedProjectLedgerRecords(canonicalRoot, paths).map((item: { raw: string | null }) => item.raw))
      .toEqual([oldHead, null, null]);
    expectCommittedOldIndex();

    const recovered = loadPreparedProjectLedgerPublication(transaction);
    promoteProjectLedgerPublication(recovered, () => { throw new Error("No whole-root exchange is allowed"); });
    expect(() => observeProjectLedgerPromotion(recovered, () => { throw new Error("Receipt write interrupted"); }))
      .toThrow("Receipt write interrupted");
    expect(readCommittedProjectLedgerRecords(canonicalRoot, paths).map((item: { raw: string | null }) => item.raw))
      .toEqual([oldHead, null, null]);
    expectCommittedOldIndex();

    observeProjectLedgerPromotion(recovered, () => {
      expect(existsSync(publication.claimPath)).toBe(true);
    });
    expect(readCommittedProjectLedgerRecords(canonicalRoot, paths).map((item: { raw: string | null }) => item.raw))
      .toEqual([oldRetired, newHead, "new Work binding"]);
    expect(existsSync(publication.claimPath)).toBe(false);
    expect(existsSync(candidateRoot)).toBe(false);
    expect(existsSync(`${candidateRoot}.before`)).toBe(false);
    expect(statSync(join(canonicalRoot, "references/history.md")).mtimeMs).toBe(historyTime);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
