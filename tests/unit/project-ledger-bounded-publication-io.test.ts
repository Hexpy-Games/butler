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
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const projectLedgerSource = join(process.cwd(), "packages", "project-ledger", "src");

test("Project Ledger copyDirectory copies large nested files without a parent-sized read buffer", async () => {
  const source = mkdtempSync(join(tmpdir(), "project-ledger-copy-source-"));
  const target = mkdtempSync(join(tmpdir(), "project-ledger-copy-target-"));
  try {
    const content = Buffer.alloc(384 * 1024 + 17);
    for (let index = 0; index < content.length; index += 1) content[index] = index % 251;
    const sourcePath = join(source, "references", "large.bin");
    mkdirSync(join(source, "references"), { recursive: true });
    writeFileSync(sourcePath, content);

    const { copyDirectory } = await importCore("fs.js");
    copyDirectory(source, target);

    expect(readFileSync(join(target, "references", "large.bin"))).toEqual(content);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("copyDirectory uses the bounded copy primitive rather than whole-file read/write", () => {
  const source = readFileSync(join(projectLedgerSource, "fs.js"), "utf8");
  const start = source.indexOf("export function copyDirectory");
  const end = source.indexOf("export function replaceWithSymlink", start);
  const implementation = source.slice(start, end);
  expect(implementation).toContain("copyFileSync(sourcePath, targetPath)");
  expect(implementation).not.toContain("readFileSync");
  expect(implementation).not.toContain("writeFileSync");
});

test("source-head storage digest preserves the legacy entry and byte ordering", async () => {
  const root = mkdtempSync(join(tmpdir(), "project-ledger-storage-hash-"));
  try {
    writeFileSync(join(root, "project.json"), `${JSON.stringify({
      schema: "project-ledger.project.v1",
      id: "storage-fixture",
      name: "Storage fixture",
    })}\n`, "utf8");
    writeFileSync(join(root, "ledger.jsonl"), `${JSON.stringify({ type: "fixture" })}\n`, "utf8");
    mkdirSync(join(root, "references"), { recursive: true });
    writeFileSync(join(root, "references", "bytes.bin"), Buffer.from([0, 1, 2, 127, 128, 255]));

    const transactions = await importCore("transactions/index.js");
    const observed = transactions.observeProjectLedgerSourceHead(root);
    const entries = [
      { kind: "file", path: join(root, "ledger.jsonl") },
      { kind: "file", path: join(root, "project.json") },
      { kind: "directory", path: join(root, "references") },
      { kind: "file", path: join(root, "references", "bytes.bin") },
    ].sort((left, right) => relative(root, left.path).localeCompare(relative(root, right.path)));
    const expected = createHash("sha256");
    for (const entry of entries) {
      expected.update(entry.kind);
      expected.update("\0");
      expected.update(relative(root, entry.path).split("\\").join("/").normalize("NFC"));
      expected.update("\0");
      if (entry.kind === "file") expected.update(readFileSync(entry.path));
      expected.update("\0");
    }

    expect(observed.storageSha256).toBe(expected.digest("hex"));
    expect(observed.storageEntryCount).toBe(entries.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("publication I/O paths do not regress to whole-file materialization", () => {
  const sourceHead = readFileSync(
    join(projectLedgerSource, "transactions", "source-head.js"),
    "utf8",
  );
  const observeStart = sourceHead.indexOf("export function observeProjectLedgerSourceHead");
  const semanticCompatibilityStart = sourceHead.indexOf("export function canonicalProjectLedgerSemantics");
  const observeImplementation = sourceHead.slice(observeStart, semanticCompatibilityStart);
  expect(observeImplementation).toContain("storageBuffer");
  expect(observeImplementation).toContain("updateHashFromFile");
  expect(observeImplementation).not.toContain("readFileSync");

  const integrity = readFileSync(
    join(projectLedgerSource, "transactions", "publication-integrity.js"),
    "utf8",
  );
  const validationStart = integrity.indexOf("function assertEventLogReadable");
  const validationEnd = integrity.indexOf("export class ProjectLedgerEventLogLineTooLargeError", validationStart);
  const validationImplementation = integrity.slice(validationStart, validationEnd);
  expect(validationImplementation).toContain("readSync");
  expect(validationImplementation).not.toContain("readFileSync");
  expect(validationImplementation).not.toContain('.split("\\n")');
});

test("publication event-log validation is line bounded and preserves valid UTF-8 records", async () => {
  const project = mkdtempSync(join(tmpdir(), "project-ledger-event-log-"));
  try {
    const { handle } = await importCore("commands.js");
    const { ledgerRoot } = await importCore("fs.js");
    const { inspectPublicationRoot } = await importCore("transactions/publication-integrity.js");
    handle("init", [], { project, id: "event-log-fixture", name: "Event log fixture" });
    refreshDerivedLedger(handle, project);
    const root = ledgerRoot(project);
    const eventLog = join(root, "ledger.jsonl");

    writeFileSync(eventLog, JSON.stringify({ text: "한😀".repeat(20_000) }), "utf8");
    expect(() => inspectPublicationRoot(root)).not.toThrow();

    writeFileSync(eventLog, `${JSON.stringify({ text: "x".repeat(4 * 1024 * 1024) })}\n`, "utf8");
    let error: unknown = null;
    try {
      inspectPublicationRoot(root);
    } catch (caught) {
      error = caught;
    }
    expect((error as { code?: string } | null)?.code).toBe("project_ledger_event_line_too_large");
    expect((error as { name?: string } | null)?.name).toBe("ProjectLedgerEventLogLineTooLargeError");
    expect((error as Error | null)?.message).toBe(
      "Project Ledger event log line exceeds the bounded validation limit",
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

async function importCore(name: string): Promise<any> {
  return import(pathToFileURL(join(projectLedgerSource, name)).href);
}

function refreshDerivedLedger(handle: (...args: any[]) => any, project: string): void {
  for (const view of ["dashboard", "handoff", "roadmap"]) {
    handle("render", [view], { project, write: true });
  }
  handle("index", [], { project });
}
