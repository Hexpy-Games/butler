import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";

const root = process.cwd();
const srcRoot = join(root, "packages", "project-ledger", "src");

async function importModule(name: string): Promise<any> {
  return import(pathToFileURL(join(srcRoot, name)).href);
}

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), "project-ledger-core-"));
}

test("Project Ledger core modules can be imported and used without spawning the CLI", async () => {
  const project = tempProject();
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
    expect(existsSync(join(project, ".project-ledger", "work", "W-CORE", "work.md"))).toBe(true);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("Project Ledger check fails on stale generated views and passes after render plus index", async () => {
  const project = tempProject();
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
    rmSync(project, { recursive: true, force: true });
  }
});

test("Project Ledger ignores platform metadata files when checking freshness", async () => {
  const project = tempProject();
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

    writeFileSync(join(project, ".project-ledger", ".DS_Store"), "ignored metadata", "utf8");

    expect(handle("check", [], { project }).ok).toBe(true);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
