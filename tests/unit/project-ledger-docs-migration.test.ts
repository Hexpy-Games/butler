import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { pathToFileURL } from "url";
import { spawnSync } from "child_process";

const root = process.cwd();
const cliPath = join(root, "packages", "project-ledger", "bin", "project-ledger");
const migrationModuleUrl = pathToFileURL(
  join(root, "packages", "project-ledger", "src", "docs-migration.js"),
).href;

function tempProject(): string {
  const project = mkdtempSync(join(tmpdir(), "project-ledger-docs-"));
  writeProjectFile(
    project,
    "package.json",
    `${JSON.stringify({ name: "demo", private: true }, null, 2)}\n`,
  );
  return project;
}

function testButlerData(project: string): string {
  return join(project, ".butler-data");
}

function ledgerProjectRoot(project: string): string {
  return join(testButlerData(project), "project-ledger", "projects", "demo");
}

function writeProjectFile(project: string, relPath: string, text: string): void {
  const path = join(project, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

function projectArg(args: string[]): string | null {
  const index = args.indexOf("--project");
  return index >= 0 ? args[index + 1] ?? null : null;
}

function runLedgerJson(args: string[]): any {
  const project = projectArg(args);
  const env = project ? { BUTLER_DATA: testButlerData(project) } : {};
  const result = spawnSync(process.execPath, [cliPath, ...args, "--json"], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}

test("migrate-docs moves supported docs into Project Ledger and leaves compatibility symlinks", async () => {
  const project = tempProject();
  try {
    runLedgerJson(["init", "--project", project, "--id", "demo", "--name", "Demo"]);
    writeProjectFile(project, "docs/specs/example.md", "# Example Spec\n\nStatus: Complete\n");
    writeProjectFile(project, "docs/reports/example-report.md", "# Example Report\n");
    writeProjectFile(project, "docs/plan-example.md", "# Example Plan\n");
    writeProjectFile(project, "docs/handoffs/privacy-policy.md", "# Privacy Policy\n\nDo not store private transcript text.\n");
    writeProjectFile(project, "docs/architecture.md", "# Architecture\n");
    writeProjectFile(project, "docs/notes.md", "# Notes\n");

    const { planDocsMigration } = await import(migrationModuleUrl) as any;
    const plan = planDocsMigration(project);
    expect(plan.moves.map((item: any) => item.target)).toContain("specs/example.md");
    expect(plan.unsupported.map((item: any) => item.path)).toEqual(["docs/notes.md"]);

    const dryRun = runLedgerJson(["migrate-docs", "--project", project]);
    expect(dryRun.data.written).toBe(false);
    expect(existsSync(join(ledgerProjectRoot(project), "specs", "example.md"))).toBe(false);

    const written = runLedgerJson(["migrate-docs", "--project", project, "--write"]);
    expect(written.data.written).toBe(true);
    expect(written.data.moves).toHaveLength(5);

    const source = join(project, "docs", "specs", "example.md");
    const target = join(ledgerProjectRoot(project), "specs", "example.md");
    expect(lstatSync(source).isSymbolicLink()).toBe(true);
    expect(join(dirname(source), readlinkSync(source))).toBe(target);

    const migrated = readFileSync(target, "utf8");
    expect(migrated).toContain('kind: "spec"');
    expect(migrated).toContain('migratedFrom: "docs/specs/example.md"');
    expect(migrated).toContain("# Example Spec");
    expect(readFileSync(join(project, "docs", "specs", "example.md"), "utf8")).toContain("# Example Spec");

    for (const view of ["dashboard", "handoff", "roadmap"]) {
      runLedgerJson(["render", "--project", project, view, "--write"]);
    }
    const index = runLedgerJson(["index", "--project", project]);
    expect(index.data.counts.spec).toBe(1);
    expect(index.data.counts.report).toBe(1);
    expect(index.data.counts.plan).toBe(1);
    expect(index.data.counts.handoff).toBe(1);
    expect(index.data.counts.reference).toBe(1);
    expect(runLedgerJson(["check", "--project", project]).data.issueCount).toBe(0);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
