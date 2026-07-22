import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { hostname, tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";

const root = process.cwd();
const srcRoot = join(root, "packages", "project-ledger", "src");

async function importModule(name: string): Promise<any> {
  return import(pathToFileURL(join(srcRoot, name)).href);
}

function tempProject(): string {
  const project = mkdtempSync(join(tmpdir(), "project-ledger-core-"));
  writeFileSync(
    join(project, "package.json"),
    `${JSON.stringify({ name: "demo", private: true }, null, 2)}\n`,
    "utf8",
  );
  return project;
}

function testButlerData(project: string): string {
  return join(project, ".butler-data");
}

function ledgerProjectRoot(project: string, id = "demo"): string {
  return join(testButlerData(project), "project-ledger", "projects", id);
}

function writeWork(project: string, id: string, frontmatter: Record<string, string>): string {
  const dir = join(ledgerProjectRoot(project), "work", id);
  mkdirSync(dir, { recursive: true });
  const body = [
    "---",
    ...Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`),
    "---",
    "",
    `# ${frontmatter.title ?? id}`,
    "",
  ].join("\n");
  const path = join(dir, "work.md");
  writeFileSync(path, body, "utf8");
  return path;
}

function useTestButlerData(project: string): () => void {
  const previousButlerData = process.env.BUTLER_DATA;
  process.env.BUTLER_DATA = testButlerData(project);
  return () => {
    if (previousButlerData === undefined) delete process.env.BUTLER_DATA;
    else process.env.BUTLER_DATA = previousButlerData;
  };
}

test("Project Ledger core modules can be imported and used without spawning the CLI", async () => {
  const project = tempProject();
  const restoreButlerData = useTestButlerData(project);
  try {
    const { handle } = await importModule("commands.js");
    const { projectStatus, queryIndex, loadIndex } = await importModule("indexer.js");

    handle("init", [], { project, id: "demo", name: "Demo Project" });
    handle("work", ["create"], {
      project,
      id: "W-CORE",
      title: "Core import test",
      spec: "docs/specs/project-ledger.md",
      acceptance: "Core modules are importable",
      status: "proposed",
    });
    handle("work", ["update"], { project, id: "W-CORE", status: "scoped" });
    handle("work", ["update"], { project, id: "W-CORE", status: "specified" });
    handle("work", ["update"], { project, id: "W-CORE", status: "in_progress" });
    handle("work", ["update"], { project, id: "W-CORE", status: "review" });
    handle("work", ["complete"], {
      project,
      id: "W-CORE",
      validation: "bun test tests/unit/project-ledger-core.test.ts",
      review: "internal direct import review",
      report: "docs/reports/project-ledger-pl2-pl7.md",
    });
    handle("index", [], { project });

    const status = projectStatus(project);
    expect(status.counts.work).toBe(1);
    expect(queryIndex(loadIndex(project), "recent-completed").map((item: any) => item.id)).toContain("W-CORE");
    expect(existsSync(join(ledgerProjectRoot(project), "work", "W-CORE", "work.md"))).toBe(true);
  } finally {
    restoreButlerData();
    rmSync(project, { recursive: true, force: true });
  }
});

test("Project Ledger mutations recover an exact dead process claim", async () => {
  const project = tempProject();
  const restoreButlerData = useTestButlerData(project);
  try {
    const { handle } = await importModule("commands.js");
    const { mutationLockPath, withProjectLedgerMutation } =
      await importModule("mutation-lock.js");
    handle("init", [], { project, id: "demo", name: "Demo Project" });
    const lockPath = mutationLockPath(project);
    mkdirSync(join(lockPath, ".."), { recursive: true });
    writeFileSync(lockPath, `${JSON.stringify({
      schema: "project-ledger.mutation-claim.v1",
      claimId: "dead-claim",
      hostId: hostname(),
      processId: 2_147_483_647,
      processStartedAtMs: 1,
    })}\n`, "utf8");

    expect(withProjectLedgerMutation(project, () => "recovered")).toBe("recovered");
    expect(existsSync(lockPath)).toBe(false);
  } finally {
    restoreButlerData();
    rmSync(project, { recursive: true, force: true });
  }
});

test("Project Ledger core record commands create show and update generic records", async () => {
  const project = tempProject();
  const restoreButlerData = useTestButlerData(project);
  try {
    const { handle } = await importModule("commands.js");

    handle("init", [], { project, id: "demo", name: "Demo Project" });
    const created = handle("record", ["create"], {
      project,
      kind: "reference",
      id: "REF-CORE",
      title: "Core Reference",
    });
    expect(created.kind).toBe("reference");
    expect(created.id).toBe("REF-CORE");

    const referencePath = join(ledgerProjectRoot(project), "references", "ref-core.md");
    expect(readFileSync(referencePath, "utf8")).toContain("# Core Reference");
    writeFileSync(
      referencePath,
      readFileSync(referencePath, "utf8").replace('kind: "reference"', 'kind: "reference"\nowner: "ledger"'),
      "utf8",
    );

    const updated = handle("record", ["update"], {
      project,
      kind: "reference",
      id: "REF-CORE",
      title: "Updated Core Reference",
      validation: "core test",
    });
    expect(updated.title).toBe("Updated Core Reference");
    expect(updated.validation).toBe("core test");

    const text = readFileSync(referencePath, "utf8");
    expect(text).toContain('owner: "ledger"');
    expect(text).toContain("# Core Reference");

    const shown = handle("record", ["show"], {
      project,
      kind: "reference",
      id: "REF-CORE",
      body: true,
    });
    expect(shown.body).toContain("# Core Reference");
    expect(readFileSync(join(ledgerProjectRoot(project), "ledger.jsonl"), "utf8")).toContain("reference_updated");
  } finally {
    restoreButlerData();
    rmSync(project, { recursive: true, force: true });
  }
});

test("Project Ledger core generic lifecycle update validates transitions and completion gates", async () => {
  const project = tempProject();
  const restoreButlerData = useTestButlerData(project);
  try {
    const { handle } = await importModule("commands.js");

    handle("init", [], { project, id: "demo", name: "Demo Project" });
    handle("work", ["create"], {
      project,
      id: "W-LIFECYCLE-CORE",
      title: "Core lifecycle work",
      spec: "SPEC-LIFECYCLE-CORE",
      acceptance: "Core lifecycle validation works",
    });
    expect(handle("record", ["update"], {
      project,
      kind: "work",
      id: "W-LIFECYCLE-CORE",
      status: "scoped",
    }).status).toBe("scoped");

    expect(() => handle("record", ["update"], {
      project,
      kind: "work",
      id: "W-LIFECYCLE-CORE",
      status: "done",
    })).toThrow("Invalid work transition: scoped -> done");

    handle("record", ["update"], { project, kind: "work", id: "W-LIFECYCLE-CORE", status: "specified" });
    handle("record", ["update"], { project, kind: "work", id: "W-LIFECYCLE-CORE", status: "in_progress" });
    handle("record", ["update"], { project, kind: "work", id: "W-LIFECYCLE-CORE", status: "review" });

    expect(() => handle("record", ["update"], {
      project,
      kind: "work",
      id: "W-LIFECYCLE-CORE",
      status: "done",
    })).toThrow("Work completion gate failed: validation, review, report");

    expect(handle("record", ["update"], {
      project,
      kind: "work",
      id: "W-LIFECYCLE-CORE",
      status: "done",
      validation: "validated",
      review: "reviewed",
      report: "reports/core-lifecycle.md",
    }).status).toBe("done");
  } finally {
    restoreButlerData();
    rmSync(project, { recursive: true, force: true });
  }
});

test("Project Ledger uses Butler data project roots with canonical labels", async () => {
  const rootDir = tempProject();
  const previousButlerData = process.env.BUTLER_DATA;
  try {
    const butlerData = join(rootDir, "data");
    const workspace = join(rootDir, "workspace");
    const canonicalProject = join(butlerData, "project-ledger", "projects", "demo");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: "demo" }), "utf8");
    process.env.BUTLER_DATA = butlerData;

    const { handle } = await importModule("commands.js");
    const { projectStatus, queryIndex, loadIndex } = await importModule("indexer.js");
    const { projectPath } = await importModule("fs.js");

    const initialized = handle("init", [], {
      project: canonicalProject,
      id: "demo",
      name: "Demo Project",
    });
    expect(initialized.root).toBe("project-ledger/projects/demo");

    handle("work", ["create"], {
      project: workspace,
      id: "W-CANONICAL",
      title: "Canonical root test",
      spec: "project-ledger/projects/demo/specs/project-ledger.md",
      acceptance: "Canonical Project Ledger paths are returned",
      status: "specified",
    });
    handle("index", [], { project: workspace });

    const status = projectStatus(workspace);
    expect(status.project.path).toBe("project-ledger/projects/demo/project.json");
    expect(status.index.path).toBe("project-ledger/projects/demo/index/project.json");
    expect(status.nextActions[0].path).toBe(
      "project-ledger/projects/demo/work/W-CANONICAL/work.md",
    );
    expect(queryIndex(loadIndex(workspace), "next-actions")[0].path).toBe(
      "project-ledger/projects/demo/work/W-CANONICAL/work.md",
    );
    expect(projectPath(workspace, status.nextActions[0].path)).toBe(
      join(canonicalProject, "work", "W-CANONICAL", "work.md"),
    );
  } finally {
    if (previousButlerData === undefined) delete process.env.BUTLER_DATA;
    else process.env.BUTLER_DATA = previousButlerData;
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("Project Ledger check fails on stale generated views and passes after render plus index", async () => {
  const project = tempProject();
  const restoreButlerData = useTestButlerData(project);
  try {
    const { handle } = await importModule("commands.js");

    handle("init", [], { project, id: "demo", name: "Demo Project" });
    handle("work", ["create"], {
      project,
      id: "W-CHECK",
      title: "Check gate test",
      spec: "docs/specs/project-ledger.md",
      acceptance: "Check catches stale views",
      status: "proposed",
    });
    handle("index", [], { project });
    expect(handle("check", [], { project }).ok).toBe(false);

    handle("render", ["dashboard"], { project, write: true });
    handle("render", ["handoff"], { project, write: true });
    handle("render", ["roadmap"], { project, write: true });
    handle("index", [], { project });

    expect(handle("check", [], { project }).ok).toBe(true);
  } finally {
    restoreButlerData();
    rmSync(project, { recursive: true, force: true });
  }
});

test("Project Ledger status refreshes stored view freshness after render", async () => {
  const project = tempProject();
  const restoreButlerData = useTestButlerData(project);
  try {
    const { handle } = await importModule("commands.js");

    handle("init", [], { project, id: "demo", name: "Demo Project" });
    handle("work", ["create"], {
      project,
      id: "W-STATUS",
      title: "Status freshness test",
      spec: "docs/specs/project-ledger.md",
      acceptance: "Status does not report stale views after render",
      status: "proposed",
    });
    handle("index", [], { project });
    expect(handle("status", [], { project }).staleViews).toHaveLength(3);

    handle("render", ["dashboard"], { project, write: true });
    handle("render", ["handoff"], { project, write: true });
    handle("render", ["roadmap"], { project, write: true });

    expect(handle("check", [], { project }).ok).toBe(true);
    expect(handle("status", [], { project }).staleViews).toEqual([]);
  } finally {
    restoreButlerData();
    rmSync(project, { recursive: true, force: true });
  }
});

test("Project Ledger mutations refresh the compact index before returning", async () => {
  const project = tempProject();
  const restoreButlerData = useTestButlerData(project);
  try {
    const { handle } = await importModule("commands.js");

    handle("init", [], { project, id: "demo", name: "Demo Project" });
    const created = handle("work", ["create"], {
      project,
      id: "W-MUTATION-REFRESH",
      title: "Mutation refresh test",
      spec: "docs/specs/project-ledger.md",
      acceptance: "Mutation commands refresh compact index",
      status: "proposed",
    });

    expect(created.derived.index_refresh.ok).toBe(true);
    const indexPath = join(ledgerProjectRoot(project), "index", "project.json");
    expect(existsSync(indexPath)).toBe(true);
    expect(JSON.parse(readFileSync(indexPath, "utf8")).records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "W-MUTATION-REFRESH", status: "proposed" }),
      ]),
    );

    handle("work", ["update"], {
      project,
      id: "W-MUTATION-REFRESH",
      status: "scoped",
    });
    expect(JSON.parse(readFileSync(indexPath, "utf8")).records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "W-MUTATION-REFRESH", status: "scoped" }),
      ]),
    );
  } finally {
    restoreButlerData();
    rmSync(project, { recursive: true, force: true });
  }
});

test("Project Ledger reads rebuild from source when the compact index is stale", async () => {
  const project = tempProject();
  const restoreButlerData = useTestButlerData(project);
  try {
    const { handle } = await importModule("commands.js");
    const { loadIndex, queryIndex, readIndex } = await importModule("indexer.js");

    handle("init", [], { project, id: "demo", name: "Demo Project" });
    handle("work", ["create"], {
      project,
      id: "W-STALE-BASE",
      title: "Base indexed work",
      spec: "docs/specs/project-ledger.md",
      acceptance: "Initial index exists",
      status: "proposed",
    });
    handle("index", [], { project });

    const indexPath = join(ledgerProjectRoot(project), "index", "project.json");
    const past = new Date(Date.now() - 5000);
    utimesSync(indexPath, past, past);

    writeWork(project, "W-STALE-SOURCE", {
      schema: "project-ledger.work.v1",
      kind: "work",
      id: "W-STALE-SOURCE",
      title: "Manual source truth",
      status: "specified",
      spec: "docs/specs/project-ledger.md",
      acceptance: "Reads must trust source over stale cache",
    });

    expect(readIndex(project).index.stale).toBe(true);
    const nextActions = queryIndex(loadIndex(project), "next-actions").map((item: any) => item.id);
    expect(nextActions).toContain("W-STALE-SOURCE");
    expect(readIndex(project).index.stale).toBe(false);
  } finally {
    restoreButlerData();
    rmSync(project, { recursive: true, force: true });
  }
});

test("Project Ledger reads answer from source when the compact index cannot be rewritten", async () => {
  const project = tempProject();
  const restoreButlerData = useTestButlerData(project);
  try {
    const { handle } = await importModule("commands.js");
    const { loadIndex, queryIndex } = await importModule("indexer.js");

    handle("init", [], { project, id: "demo", name: "Demo Project" });
    handle("work", ["create"], {
      project,
      id: "W-READ-FALLBACK",
      title: "Read fallback work",
      spec: "docs/specs/project-ledger.md",
      acceptance: "Reads use source truth when cache writes fail",
      status: "specified",
    });

    const indexPath = join(ledgerProjectRoot(project), "index", "project.json");
    rmSync(indexPath, { force: true });
    mkdirSync(indexPath, { recursive: true });

    expect(handle("status", [], { project }).nextActions.map((item: any) => item.id)).toContain("W-READ-FALLBACK");
    expect(queryIndex(loadIndex(project), "next-actions").map((item: any) => item.id)).toContain("W-READ-FALLBACK");
  } finally {
    restoreButlerData();
    rmSync(project, { recursive: true, force: true });
  }
});

test("Project Ledger ignores platform metadata files when checking freshness", async () => {
  const project = tempProject();
  const restoreButlerData = useTestButlerData(project);
  try {
    const { handle } = await importModule("commands.js");

    handle("init", [], { project, id: "demo", name: "Demo Project" });
    handle("work", ["create"], {
      project,
      id: "W-METADATA",
      title: "Metadata ignore test",
      spec: "docs/specs/project-ledger.md",
      acceptance: "Ignored platform metadata does not stale the ledger",
      status: "proposed",
    });
    handle("render", ["dashboard"], { project, write: true });
    handle("render", ["handoff"], { project, write: true });
    handle("render", ["roadmap"], { project, write: true });
    handle("index", [], { project });

    writeFileSync(join(ledgerProjectRoot(project), ".DS_Store"), "ignored metadata", "utf8");
    writeFileSync(
      join(ledgerProjectRoot(project), "work", "W-METADATA", "github-issues.json"),
      `${JSON.stringify({ issues: [] }, null, 2)}\n`,
      "utf8",
    );

    expect(handle("check", [], { project }).ok).toBe(true);
  } finally {
    restoreButlerData();
    rmSync(project, { recursive: true, force: true });
  }
});
