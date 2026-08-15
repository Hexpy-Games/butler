import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const sourceHeadPath = join(
  process.cwd(),
  "packages",
  "project-ledger",
  "src",
  "transactions",
  "source-head.js",
);

test("incremental source-head digest preserves canonical semantics across Unicode, frontmatter, body, and order fixtures", async () => {
  const root = mkdtempSync(join(tmpdir(), "project-ledger-source-head-equivalence-"));
  try {
    writeFixture(root, [
      {
        path: ["references", "zeta.md"],
        text: "---\nid: ZETA\nkind: reference\ntitle: \"Café\"\nupdatedAt: old\npath: ignored\n---\n\n본문 à 😀\n",
      },
      {
        path: ["work", "omega.md"],
        text: "---\ntitle: Omega\nid: OMEGA\nkind: work\nstatus: in_progress\nsourceMtimeMs: 1\n---\n\nSecond body\n",
      },
      {
        path: ["project.json"],
        text: `${JSON.stringify({
          schema: "project-ledger.project.v1",
          id: "fixture",
          name: "Fixture",
          status: "active",
          updatedAt: "ignored",
        }, null, 2)}\n`,
      },
    ]);
    const transactions = await import(pathToFileURL(join(
      process.cwd(),
      "packages",
      "project-ledger",
      "src",
      "transactions",
      "index.js",
    )).href);
    const legacyCanonical = transactions.canonicalProjectLedgerSemantics(root);
    const expectedDigest = createHash("sha256").update(legacyCanonical).digest("hex");
    const observed = transactions.observeProjectLedgerSourceHead(root);

    expect(observed.sourceSha256).toBe(expectedDigest);
    expect(observed.sourceFileCount).toBe(3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("source-head observation does not retain the legacy full-corpus semantic array path", () => {
  const source = readFileSync(sourceHeadPath, "utf8");
  const observeStart = source.indexOf("export function observeProjectLedgerSourceHead");
  const compatibilityStart = source.indexOf("export function canonicalProjectLedgerSemantics");
  expect(observeStart).toBeGreaterThanOrEqual(0);
  expect(compatibilityStart).toBeGreaterThan(observeStart);
  const observeImplementation = source.slice(observeStart, compatibilityStart);
  expect(observeImplementation).not.toContain("const semanticRecords =");
  expect(observeImplementation).not.toContain("canonicalJson(semanticRecords)");
});

function writeFixture(
  root: string,
  files: Array<{ path: string[]; text: string }>,
): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "ledger.jsonl"), "", "utf8");
  for (const file of files) {
    const path = join(root, ...file.path);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, file.text, "utf8");
  }
}
