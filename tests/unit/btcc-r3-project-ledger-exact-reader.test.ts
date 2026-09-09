import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  readStableExactProjectLedgerSnapshot,
  revalidateExactLedgerPreconditions,
  type ExactLedgerTarget,
} from "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/canonical-ledger-reader.ts";
import { observeProjectLedgerHead } from "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/observe-project-ledger.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("exact reader preserves repeated IDs by their exact indexed source paths", async () => {
  const root = fixture();
  const first = target("work/W-1/tasks/T-1/attempts/A-SHARED.md", "A-SHARED", "attempt", "T-1");
  const second = target("work/W-1/tasks/T-2/attempts/A-SHARED.md", "A-SHARED", "attempt", "T-2");
  writeRecord(root, first, { attempt: 1 });
  writeRecord(root, second, { attempt: 2 });

  const snapshot = await readStableExactProjectLedgerSnapshot({ projectRoot: root, targets: [first, second] });

  expect(snapshot.records.map(({ path, parentId, body }) => ({ path, parentId, body }))).toEqual([
    { path: first.path, parentId: "T-1", body: JSON.stringify({ attempt: 1 }) + "\n" },
    { path: second.path, parentId: "T-2", body: JSON.stringify({ attempt: 2 }) + "\n" },
  ]);
  expect(snapshot.targetPreconditions.every((item) => item.state === "present")).toBe(true);
  revalidateExactLedgerPreconditions(root, snapshot.targetPreconditions);
});

test("exact reader retries only boundedly across unequal complete H1 and H2", async () => {
  const root = fixture();
  const item = target("references/REF-1.md", "REF-1", "reference", "W-1");
  writeRecord(root, item, { value: 1 });
  const base = await observeProjectLedgerHead(root);
  let observations = 0;
  const dependencies = {
    async observeHead() {
      observations += 1;
      return observations === 1 ? { ...base, storageEntryCount: base.storageEntryCount + 1 } : base;
    },
  };

  const snapshot = await readStableExactProjectLedgerSnapshot(
    { projectRoot: root, targets: [item], maxAttempts: 2 },
    dependencies,
  );
  expect(observations).toBe(4);
  expect(snapshot.expectedBase).toEqual(base);

  let serial = 0;
  await expect(readStableExactProjectLedgerSnapshot(
    { projectRoot: root, targets: [item], maxAttempts: 2 },
    { async observeHead() { serial += 1; return { ...base, sourceFileCount: serial }; } },
  )).rejects.toThrow("project_ledger_exact_reader_unstable_source");
  expect(serial).toBe(4);
});

test("an absent exact target permits the same kind and id at another legal path", async () => {
  const root = fixture();
  const present = target("work/W-1/tasks/T-1/attempts/A-SHARED.md", "A-SHARED", "attempt", "T-1");
  const absent = target("work/W-1/tasks/T-2/attempts/A-SHARED.md", "A-SHARED", "attempt", "T-2");
  writeRecord(root, present, { attempt: 1 });

  const snapshot = await readStableExactProjectLedgerSnapshot({ projectRoot: root, targets: [absent] });

  expect(snapshot.records).toEqual([]);
  expect(snapshot.targetPreconditions).toEqual([{ ...absent, state: "absent" }]);
  revalidateExactLedgerPreconditions(root, snapshot.targetPreconditions);
});

test("exact reader fails closed on path, parent, hash, absence, and official metadata corruption", async () => {
  const root = fixture();
  const item = target("references/REF-STRICT.md", "REF-STRICT", "reference", "W-1");
  writeRecord(root, item, { value: 1 });
  const snapshot = await readStableExactProjectLedgerSnapshot({ projectRoot: root, targets: [item] });

  await expect(readStableExactProjectLedgerSnapshot({
    projectRoot: root,
    targets: [{ ...item, path: "/outside/elsewhere.md" }],
  })).rejects.toThrow("project_ledger_exact_path_outside_root");
  await expect(readStableExactProjectLedgerSnapshot({
    projectRoot: root,
    targets: [{ ...item, parentId: "W-WRONG" }],
  })).rejects.toThrow("project_ledger_exact_record_metadata_mismatch");
  writeFileSync(sourcePath(root, item), `${readFileSync(sourcePath(root, item), "utf8")} `);
  expect(() => revalidateExactLedgerPreconditions(root, snapshot.targetPreconditions))
    .toThrow("project_ledger_exact_record_hash_changed");

  const absent = target("references/REF-ABSENT.md", "REF-ABSENT", "reference", "W-1");
  const absentSnapshot = await readStableExactProjectLedgerSnapshot({ projectRoot: root, targets: [absent] });
  writeRecord(root, absent, { value: 2 });
  expect(() => revalidateExactLedgerPreconditions(root, absentSnapshot.targetPreconditions))
    .toThrow("project_ledger_exact_absence_changed");

  const malformed = target("references/REF-MALFORMED.md", "REF-MALFORMED", "reference", "W-1");
  writeRecord(root, malformed, "markdown body", true);
  writeFileSync(sourcePath(root, malformed), "---\nid: [\n---\nmarkdown body\n");
  await expect(readStableExactProjectLedgerSnapshot({ projectRoot: root, targets: [malformed] }))
    .rejects.toThrow();
});

test("exact reader rejects dangling final symlinks, escapes, and symlinked ledger roots", async () => {
  const root = fixture();
  const dangling = target("references/REF-DANGLING.md", "REF-DANGLING", "reference", "W-1");
  mkdirSync(dirname(sourcePath(root, dangling)), { recursive: true });
  symlinkSync(join(root, "missing.md"), sourcePath(root, dangling));

  await expect(readStableExactProjectLedgerSnapshot({ projectRoot: root, targets: [dangling] }))
    .rejects.toThrow("project_ledger_exact_path_symlink");
  await expect(readStableExactProjectLedgerSnapshot({
    projectRoot: root,
    targets: [{ ...dangling, path: "project-ledger/projects/ledger-project/../escape.md" }],
  })).rejects.toThrow("project_ledger_exact_path_outside_root");

  const linkedRoot = `${root}-link`;
  roots.push(linkedRoot);
  symlinkSync(root, linkedRoot, "dir");
  await expect(readStableExactProjectLedgerSnapshot({ projectRoot: linkedRoot, targets: [] }))
    .rejects.toThrow("project_ledger_root_symlink");
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "btcc-exact-reader-"));
  roots.push(root);
  writeFileSync(join(root, "project.json"), `${JSON.stringify({ id: "ledger-project", name: "Fixture", status: "active" }, null, 2)}\n`);
  writeFileSync(join(root, "ledger.jsonl"), "");
  return root;
}

function target(path: string, id: string, kind: string, parentId: string | null): ExactLedgerTarget {
  return { path: `project-ledger/projects/ledger-project/${path}`, id, kind, parentId };
}

function writeRecord(root: string, item: ExactLedgerTarget, body: unknown, rawBody = false): void {
  const path = sourcePath(root, item);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [
    "---",
    `kind: ${JSON.stringify(item.kind)}`,
    `id: ${JSON.stringify(item.id)}`,
    `title: ${JSON.stringify(item.id)}`,
    "status: \"active\"",
    ...(item.parentId ? [`parentId: ${JSON.stringify(item.parentId)}`] : []),
    "---",
    rawBody ? String(body) : JSON.stringify(body),
    "",
  ].join("\n"));
}

function sourcePath(root: string, item: ExactLedgerTarget): string {
  return join(root, item.path.replace("project-ledger/projects/ledger-project/", ""));
}
