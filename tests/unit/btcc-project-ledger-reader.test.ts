import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readCanonicalProjectLedger } from "../../packages/butler-agent/src/agent/adapters/btcc/project-ledger/canonical-ledger-reader.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("canonical reader preserves indexed paths when scoped record ids repeat", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-ledger-reader-"));
  roots.push(root);
  writeProject(root);
  writeRecord(join(root, "specs", "word-chain.md"), "spec", "SPEC-WORD-CHAIN");
  writeRecord(
    join(root, "work", "W-1", "tasks", "T-1", "attempts", "A-SHARED.md"),
    "attempt",
    "A-SHARED",
  );
  writeRecord(
    join(root, "work", "W-1", "tasks", "T-2", "attempts", "A-SHARED.md"),
    "attempt",
    "A-SHARED",
  );

  const ledger = await readCanonicalProjectLedger(root);

  expect(ledger.records.filter((record) => record.id === "A-SHARED")).toHaveLength(2);
  expect(ledger.records.find((record) => record.id === "SPEC-WORD-CHAIN"))
    .toMatchObject({ kind: "spec", body: "# SPEC-WORD-CHAIN\n" });
});

function writeProject(root: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "project.json"), `${JSON.stringify({
    id: "reader-test",
    name: "Reader Test",
    status: "active",
  }, null, 2)}\n`);
  writeFileSync(join(root, "ledger.jsonl"), "");
}

function writeRecord(path: string, kind: string, id: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [
    "---",
    `kind: "${kind}"`,
    `id: "${id}"`,
    `title: "${id}"`,
    'status: "active"',
    "---",
    "",
    `# ${id}`,
    "",
  ].join("\n"));
}
