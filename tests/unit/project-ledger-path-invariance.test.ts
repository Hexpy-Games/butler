import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type IndexedRecord = { id: string; kind: string; status: string };
type IndexedIssue = {
  code: string;
  message: string;
  record?: { id?: string } | null;
};
type LedgerIndex = { records: IndexedRecord[]; issues: IndexedIssue[] };

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("record meaning is invariant across canonical and runtime publication roots", async () => {
  const { buildIndex } = await loadIndexer();
  const dataRoot = mkdtempSync(join(tmpdir(), "project-ledger-path-invariance-"));
  roots.push(dataRoot);
  const canonical = join(dataRoot, "project-ledger", "projects", "demo");
  const candidate = join(dataRoot, "runtime", "publications", "candidates", "candidate-1");
  writeLedger(canonical);
  mkdirSync(candidate, { recursive: true });
  cpSync(canonical, candidate, { recursive: true });

  const canonicalIndex = buildIndex(canonical);
  const candidateIndex = buildIndex(candidate);

  expect(recordSemantics(candidateIndex.records)).toEqual(recordSemantics(canonicalIndex.records));
  expect(issueSemantics(candidateIndex.issues)).toEqual(issueSemantics(canonicalIndex.issues));
  expect(canonicalIndex.records.find((record) => record.id === "LEGACY-DRAFT")?.kind)
    .toBe("record");
  expect(canonicalIndex.records.find((record) => record.id === "T-CANONICAL")?.kind)
    .toBe("task");
});

function writeLedger(root: string): void {
  mkdirSync(join(root, "tasks"), { recursive: true });
  mkdirSync(join(root, "work", "W-CANONICAL", "tasks"), { recursive: true });
  writeFileSync(join(root, "project.json"), `${JSON.stringify({
    id: "demo",
    name: "Demo",
    status: "active",
  }, null, 2)}\n`);
  writeFileSync(join(root, "ledger.jsonl"), "");
  writeFileSync(join(root, "tasks", "LEGACY-DRAFT.md"), [
    "# Legacy draft",
    "",
    "Status: draft",
    "",
  ].join("\n"));
  writeFileSync(join(root, "work", "W-CANONICAL", "tasks", "T-CANONICAL.md"), [
    "---",
    'id: "T-CANONICAL"',
    'title: "Canonical task"',
    'status: "todo"',
    "---",
    "",
    "# Canonical task",
    "",
  ].join("\n"));
}

function recordSemantics(records: IndexedRecord[]) {
  return records.map(({ id, kind, status }) => ({ id, kind, status }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function issueSemantics(issues: IndexedIssue[]) {
  return issues.map((issue) => ({
    code: issue.code,
    message: issue.message,
    recordId: issue.record?.id ?? null,
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

async function loadIndexer(): Promise<{ buildIndex(root: string): LedgerIndex }> {
  const path = join(process.cwd(), "packages", "project-ledger", "src", "indexer.js");
  return import(pathToFileURL(path).href) as Promise<{ buildIndex(root: string): LedgerIndex }>;
}
