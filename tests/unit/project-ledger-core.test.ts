import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
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

    expect(handle("check", [], { project }).ok).toBe(true);
  } finally {
    restoreButlerData();
    rmSync(project, { recursive: true, force: true });
  }
});
