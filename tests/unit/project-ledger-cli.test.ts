import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const root = process.cwd();
const cliPath = join(root, "packages", "project-ledger", "bin", "project-ledger");

function tempProject(): string {
  const project = mkdtempSync(join(tmpdir(), "project-ledger-fixture-"));
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

function ledgerProjectRoot(project: string, butlerData = testButlerData(project), id = "demo"): string {
  return join(butlerData, "project-ledger", "projects", id);
}

function projectArg(args: string[]): string | null {
  const index = args.indexOf("--project");
  return index >= 0 ? args[index + 1] ?? null : null;
}

function runLedger(args: string[], options: { cwd?: string; env?: Record<string, string> } = {}): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const project = projectArg(args);
  const defaultEnv = project ? { BUTLER_DATA: testButlerData(project) } : {};
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...defaultEnv, ...options.env },
    encoding: "utf8",
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function runLedgerJson(args: string[], options: { cwd?: string; env?: Record<string, string> } = {}): any {
  const result = runLedger([...args, "--json"], options);
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
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

function writeTask(project: string, workId: string, id: string, frontmatter: Record<string, string>): string {
  const dir = join(ledgerProjectRoot(project), "work", workId, "tasks");
  mkdirSync(dir, { recursive: true });
  const body = [
    "---",
    ...Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`),
    "---",
    "",
    `# ${frontmatter.title ?? id}`,
    "",
  ].join("\n");
  const path = join(dir, `${id}.md`);
  writeFileSync(path, body, "utf8");
  return path;
}

function writeWorkInLedgerRoot(ledgerRoot: string, id: string, frontmatter: Record<string, string>): string {
  const dir = join(ledgerRoot, "work", id);
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

function renderViewsAndIndex(project: string): void {
  for (const view of ["dashboard", "handoff", "roadmap"]) {
    runLedgerJson(["render", "--project", project, view, "--write"]);
  }
  runLedgerJson(["index", "--project", project]);
}

test("project-ledger root help aliases print the command reference", () => {
  for (const args of [["help"], ["--help"]]) {
    const result = runLedger(args);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Project Ledger CLI");
    expect(result.stdout).toContain("project-ledger init --project PATH --id ID --name NAME");
  }
});

test("project-ledger init creates Butler data-home ledger layout", () => {
  const project = tempProject();
  try {
    const result = runLedgerJson([
      "init",
      "--project",
      project,
      "--id",
      "demo",
      "--name",
      "Demo Project",
    ]);

    expect(result.ok).toBe(true);
    expect(result.data.project.id).toBe("demo");
    const dataProject = ledgerProjectRoot(project);
    expect(result.data.root).toBe("project-ledger/projects/demo");
    expect(existsSync(join(dataProject, "project.json"))).toBe(true);
    expect(existsSync(join(dataProject, "ledger.jsonl"))).toBe(true);
    for (const dir of ["initiatives", "work", "decisions", "risks", "specs", "reports", "index", "views"]) {
      expect(existsSync(join(dataProject, dir))).toBe(true);
    }

    const projectJson = JSON.parse(readFileSync(join(dataProject, "project.json"), "utf8"));
    expect(projectJson.schema).toBe("project-ledger.project.v1");
    expect(readFileSync(join(dataProject, "ledger.jsonl"), "utf8")).toContain("project_initialized");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("project-ledger resolves an existing Butler data-home project", () => {
  const project = tempProject();
  const butlerData = mkdtempSync(join(tmpdir(), "project-ledger-data-home-"));
  const dataProject = join(butlerData, "project-ledger", "projects", "demo");
  try {
    mkdirSync(dataProject, { recursive: true });
    writeFileSync(
      join(dataProject, "project.json"),
      `${JSON.stringify({
        schema: "project-ledger.project.v1",
        id: "demo",
        name: "Demo Project From Data Home",
        status: "active",
      }, null, 2)}\n`,
      "utf8",
    );
    writeFileSync(join(dataProject, "ledger.jsonl"), "", "utf8");
    writeWorkInLedgerRoot(dataProject, "DATA-HOME-WORK", {
      id: "DATA-HOME-WORK",
      kind: "work",
      title: "Data home work",
      status: "in_progress",
      spec: "docs/specs/project-ledger.md",
    });

    const query = runLedgerJson(
      ["query", "--project", project, "--kind", "next-actions"],
      { env: { BUTLER_DATA: butlerData } },
    );
    expect(query.data.results.map((item: any) => item.id)).toEqual(["DATA-HOME-WORK"]);

    runLedgerJson(
      ["render", "--project", project, "dashboard", "--write"],
      { env: { BUTLER_DATA: butlerData } },
    );
    expect(existsSync(join(dataProject, "views", "dashboard.md"))).toBe(true);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("project-ledger resolves Butler data-home by package name without a repo-local ledger", () => {
  const project = tempProject();
  const butlerData = mkdtempSync(join(tmpdir(), "project-ledger-package-data-home-"));
  const dataProject = join(butlerData, "project-ledger", "projects", "demo");
  try {
    writeFileSync(
      join(project, "package.json"),
      `${JSON.stringify({ name: "demo", private: true }, null, 2)}\n`,
      "utf8",
    );

    mkdirSync(dataProject, { recursive: true });
    writeFileSync(
      join(dataProject, "project.json"),
      `${JSON.stringify({
        schema: "project-ledger.project.v1",
        id: "demo",
        name: "Demo Project From Data Home",
        status: "active",
      }, null, 2)}\n`,
      "utf8",
    );
    writeFileSync(join(dataProject, "ledger.jsonl"), "", "utf8");
    writeWorkInLedgerRoot(dataProject, "DATA-HOME-PACKAGE-WORK", {
      id: "DATA-HOME-PACKAGE-WORK",
      kind: "work",
      title: "Package data home work",
      status: "in_progress",
      spec: "docs/specs/project-ledger.md",
    });

    const status = runLedgerJson(
      ["status", "--project", project],
      { env: { BUTLER_DATA: butlerData } },
    );
    expect(status.data.counts.work).toBe(1);
    expect(status.data.project.name).toBe("Demo Project From Data Home");

    const query = runLedgerJson(
      ["query", "--project", project, "--kind", "next-actions"],
      { env: { BUTLER_DATA: butlerData } },
    );
    expect(query.data.results.map((item: any) => item.id)).toEqual(["DATA-HOME-PACKAGE-WORK"]);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("project-ledger resolves an external ledger repo before data-home and repo-local records", () => {
  const project = tempProject();
  const ledgerRepo = mkdtempSync(join(tmpdir(), "project-ledger-external-repo-"));
  const butlerData = mkdtempSync(join(tmpdir(), "project-ledger-external-data-home-"));
  const externalProject = join(ledgerRepo, "projects", "demo");
  const dataProject = join(butlerData, "project-ledger", "projects", "demo");
  try {
    writeFileSync(
      join(project, "package.json"),
      `${JSON.stringify({ name: "demo", private: true }, null, 2)}\n`,
      "utf8",
    );

    mkdirSync(dataProject, { recursive: true });
    writeFileSync(
      join(dataProject, "project.json"),
      `${JSON.stringify({
        schema: "project-ledger.project.v1",
        id: "demo",
        name: "Data Home Demo",
        status: "active",
      }, null, 2)}\n`,
      "utf8",
    );
    writeFileSync(join(dataProject, "ledger.jsonl"), "", "utf8");
    writeWorkInLedgerRoot(dataProject, "DATA-HOME-WORK", {
      id: "DATA-HOME-WORK",
      kind: "work",
      title: "Data home work",
      status: "in_progress",
      spec: "docs/specs/project-ledger.md",
    });

    mkdirSync(externalProject, { recursive: true });
    writeFileSync(
      join(externalProject, "project.json"),
      `${JSON.stringify({
        schema: "project-ledger.project.v1",
        id: "demo",
        name: "External Repo Demo",
        status: "active",
      }, null, 2)}\n`,
      "utf8",
    );
    writeFileSync(join(externalProject, "ledger.jsonl"), "", "utf8");
    writeWorkInLedgerRoot(externalProject, "EXTERNAL-REPO-WORK", {
      id: "EXTERNAL-REPO-WORK",
      kind: "work",
      title: "External repo work",
      status: "in_progress",
      spec: "docs/specs/project-ledger.md",
    });

    const status = runLedgerJson(
      ["status", "--project", project],
      { env: { PROJECT_LEDGER_REPO: ledgerRepo, BUTLER_DATA: butlerData } },
    );
    expect(status.data.project.name).toBe("External Repo Demo");
    expect(status.data.counts.work).toBe(1);

    const query = runLedgerJson(
      ["query", "--project", project, "--kind", "next-actions"],
      { env: { PROJECT_LEDGER_REPO: ledgerRepo, BUTLER_DATA: butlerData } },
    );
    expect(query.data.results.map((item: any) => item.id)).toEqual(["EXTERNAL-REPO-WORK"]);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(ledgerRepo, { recursive: true, force: true });
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("project-ledger completion gate requires code commit evidence when requested", () => {
  const project = tempProject();
  try {
    runLedgerJson(["init", "--project", project, "--id", "demo", "--name", "Demo Project"]);
    runLedgerJson([
      "work",
      "create",
      "--project",
      project,
      "--id",
      "W-COMMIT-EVIDENCE",
      "--title",
      "Commit evidence test",
      "--spec",
      "docs/specs/project-ledger.md",
      "--acceptance",
      "Commit evidence is captured",
      "--requires-commit-evidence",
    ]);
    for (const status of ["scoped", "specified", "in_progress", "review"]) {
      runLedgerJson(["work", "update", "--project", project, "--id", "W-COMMIT-EVIDENCE", "--status", status]);
    }

    const missingEvidence = runLedger([
      "work",
      "complete",
      "--project",
      project,
      "--id",
      "W-COMMIT-EVIDENCE",
      "--validation",
      "tested",
      "--review",
      "reviewed",
      "--report",
      "docs/reports/commit-evidence.md",
      "--json",
    ]);
    expect(missingEvidence.status).toBe(1);
    expect(JSON.parse(missingEvidence.stdout).error.details.map((item: any) => item.field)).toContain("codeCommits");

    const codeCommits = JSON.stringify([{ repo: "butler", hash: "abc123", message: "Record commit evidence" }]);
    const completed = runLedgerJson([
      "work",
      "complete",
      "--project",
      project,
      "--id",
      "W-COMMIT-EVIDENCE",
      "--validation",
      "tested",
      "--review",
      "reviewed",
      "--report",
      "docs/reports/commit-evidence.md",
      "--code-commits",
      codeCommits,
    ]);
    expect(completed.data.status).toBe("done");
    expect(completed.data.codeCommits).toBe(codeCommits);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("project-ledger index status and query return bounded project state", () => {
  const project = tempProject();
  try {
    runLedgerJson(["init", "--project", project, "--id", "demo", "--name", "Demo Project"]);
    writeWork(project, "W-0001", {
      id: "W-0001",
      kind: "work",
      title: "Build ledger MVP",
      status: "in_progress",
      spec: "docs/specs/project-ledger.md",
      priority: "1",
    });
    writeWork(project, "W-0002", {
      id: "W-0002",
      kind: "work",
      title: "Blocked integration",
      status: "blocked",
      spec: "docs/specs/project-ledger.md",
      priority: "2",
    });
    writeWork(project, "W-0003", {
      id: "W-0003",
      kind: "work",
      title: "Missing spec work",
      status: "in_progress",
      priority: "3",
    });
    writeWork(project, "W-0004", {
      id: "W-0004",
      kind: "work",
      title: "Completed setup",
      status: "done",
      spec: "docs/specs/project-ledger.md",
      priority: "4",
    });

    const indexed = runLedgerJson(["index", "--project", project]);
    expect(indexed.data.counts.work).toBe(4);

    const status = runLedgerJson(["status", "--project", project]);
    expect(status.data.project.id).toBe("demo");
    expect(status.data.counts.work).toBe(4);
    expect(status.data.nextActions[0].id).toBe("W-0001");

    const nextActions = runLedgerJson(["query", "--project", project, "--kind", "next-actions"]);
    expect(nextActions.data.results.map((item: any) => item.id)).toContain("W-0001");
    expect(nextActions.data.results.map((item: any) => item.id)).not.toContain("W-0004");

    const blocked = runLedgerJson(["query", "--project", project, "--kind", "blocked"]);
    expect(blocked.data.results.map((item: any) => item.id)).toEqual(["W-0002"]);

    const missingSpec = runLedgerJson(["query", "--project", project, "--kind", "missing-spec"]);
    expect(missingSpec.data.results.map((item: any) => item.id)).toEqual(["W-0003"]);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("project-ledger render writes generated views only with --write", () => {
  const project = tempProject();
  try {
    runLedgerJson(["init", "--project", project, "--id", "demo", "--name", "Demo Project"]);
    writeWork(project, "W-0001", {
      id: "W-0001",
      kind: "work",
      title: "Build ledger MVP",
      status: "in_progress",
      spec: "docs/specs/project-ledger.md",
      priority: "1",
    });
    runLedgerJson(["index", "--project", project]);

    const preview = runLedger(["render", "--project", project, "dashboard"]);
    expect(preview.status).toBe(0);
    expect(preview.stdout).toContain("# Project Ledger Dashboard");
    expect(existsSync(join(ledgerProjectRoot(project), "views", "dashboard.md"))).toBe(false);

    const written = runLedgerJson(["render", "--project", project, "dashboard", "--write"]);
    expect(written.data.path).toBe("project-ledger/projects/demo/views/dashboard.md");
    expect(readFileSync(join(ledgerProjectRoot(project), "views", "dashboard.md"), "utf8")).toContain(
      "generated by project-ledger",
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("project-ledger doctor detects missing spec orphan task stale view and privacy issues", () => {
  const project = tempProject();
  try {
    runLedgerJson(["init", "--project", project, "--id", "demo", "--name", "Demo Project"]);
    writeWork(project, "W-0001", {
      id: "W-0001",
      kind: "work",
      title: "Missing spec work",
      status: "in_progress",
    });
    writeTask(project, "W-0001", "T-9999", {
      id: "T-9999",
      kind: "task",
      parentId: "W-4040",
      title: "Orphan task",
      status: "todo",
    });
    writeFileSync(
      join(ledgerProjectRoot(project), "risks", "R-0001.md"),
      "---\nid: R-0001\nkind: risk\ntitle: Privacy leak\nstatus: open\n---\nTELEGRAM_BOT_TOKEN=secret\n",
      "utf8",
    );

    const doctor = runLedgerJson(["doctor", "--project", project]);
    const issueCodes = doctor.data.issues.map((issue: any) => issue.code);
    expect(issueCodes).toContain("missing_index");
    expect(issueCodes).toContain("missing_spec");
    expect(issueCodes).toContain("orphan_task");
    expect(issueCodes).toContain("stale_view");
    expect(issueCodes).toContain("possible_private_content");
    expect(JSON.stringify(doctor)).not.toContain("TELEGRAM_BOT_TOKEN=secret");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("project-ledger doctor with --silent flag suppresses output on success", () => {
  const project = tempProject();
  try {
    runLedgerJson(["init", "--project", project, "--id", "demo", "--name", "Demo Project"]);
    renderViewsAndIndex(project);

    const result = runLedger(["doctor", "--project", project, "--silent"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("project-ledger doctor with --silent flag shows concise output on failure", () => {
  const project = tempProject();
  try {
    runLedgerJson(["init", "--project", project, "--id", "demo", "--name", "Demo Project"]);
    writeWork(project, "W-0001", {
      id: "W-0001",
      kind: "work",
      title: "Missing spec work",
      status: "in_progress",
    });

    const result = runLedger(["doctor", "--project", project, "--silent"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("doctor:");
    expect(result.stdout).toContain("warning");
    expect(result.stdout).not.toContain("missing_spec");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("project-ledger doctor with --verbose flag shows detailed output", () => {
  const project = tempProject();
  try {
    runLedgerJson(["init", "--project", project, "--id", "demo", "--name", "Demo Project"]);
    writeWork(project, "W-0001", {
      id: "W-0001",
      kind: "work",
      title: "Missing spec work",
      status: "in_progress",
    });

    const result = runLedger(["doctor", "--project", project, "--verbose"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("doctor:");
    expect(result.stdout).toContain("Issues");
    expect(result.stdout).toContain("missing_spec");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("project-ledger doctor lets --verbose override --silent", () => {
  const project = tempProject();
  try {
    runLedgerJson(["init", "--project", project, "--id", "demo", "--name", "Demo Project"]);
    renderViewsAndIndex(project);

    const result = runLedger(["doctor", "--project", project, "--silent", "--verbose"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("doctor: OK");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("project-ledger doctor without flags shows concise output on failure", () => {
  const project = tempProject();
  try {
    runLedgerJson(["init", "--project", project, "--id", "demo", "--name", "Demo Project"]);
    writeWork(project, "W-0001", {
      id: "W-0001",
      kind: "work",
      title: "Missing spec work",
      status: "in_progress",
    });

    const result = runLedger(["doctor", "--project", project]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("doctor:");
    expect(result.stdout).toContain("warning");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("project-ledger check with --silent flag suppresses output on success", () => {
  const project = tempProject();
  try {
    runLedgerJson(["init", "--project", project, "--id", "demo", "--name", "Demo Project"]);
    renderViewsAndIndex(project);

    const result = runLedger(["check", "--project", project, "--silent"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("project-ledger check with --silent flag shows concise output on failure", () => {
  const project = tempProject();
  try {
    runLedgerJson(["init", "--project", project, "--id", "demo", "--name", "Demo Project"]);
    writeWork(project, "W-0001", {
      id: "W-0001",
      kind: "work",
      title: "Missing spec work",
      status: "in_progress",
    });

    const result = runLedger(["check", "--project", project, "--silent"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("check:");
    expect(result.stdout).toContain("issue");
    expect(result.stdout).not.toContain("missing_spec");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("project-ledger check with --verbose flag shows detailed output", () => {
  const project = tempProject();
  try {
    runLedgerJson(["init", "--project", project, "--id", "demo", "--name", "Demo Project"]);
    writeWork(project, "W-0001", {
      id: "W-0001",
      kind: "work",
      title: "Missing spec work",
      status: "in_progress",
    });

    const result = runLedger(["check", "--project", project, "--verbose"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("check:");
    expect(result.stdout).toContain("Issues");
    expect(result.stdout).toContain("missing_spec");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("project-ledger check lets --verbose override --silent", () => {
  const project = tempProject();
  try {
    runLedgerJson(["init", "--project", project, "--id", "demo", "--name", "Demo Project"]);
    renderViewsAndIndex(project);

    const result = runLedger(["check", "--project", project, "--silent", "--verbose"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("check: OK");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("project-ledger check without flags shows concise output on failure", () => {
  const project = tempProject();
  try {
    runLedgerJson(["init", "--project", project, "--id", "demo", "--name", "Demo Project"]);
    writeWork(project, "W-0001", {
      id: "W-0001",
      kind: "work",
      title: "Missing spec work",
      status: "in_progress",
    });

    const result = runLedger(["check", "--project", project]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("check:");
    expect(result.stdout).toContain("issue");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("project-ledger doctor preserves --json envelope behavior", () => {
  const project = tempProject();
  try {
    runLedgerJson(["init", "--project", project, "--id", "demo", "--name", "Demo Project"]);
    writeWork(project, "W-0001", {
      id: "W-0001",
      kind: "work",
      title: "Missing spec work",
      status: "in_progress",
    });

    const result = runLedgerJson(["doctor", "--project", project]);
    expect(result.ok).toBe(true);
    expect(result.data.issues).toBeDefined();
    expect(Array.isArray(result.data.issues)).toBe(true);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("project-ledger check preserves --json envelope behavior", () => {
  const project = tempProject();
  try {
    runLedgerJson(["init", "--project", project, "--id", "demo", "--name", "Demo Project"]);
    writeWork(project, "W-0001", {
      id: "W-0001",
      kind: "work",
      title: "Missing spec work",
      status: "in_progress",
    });

    const result = runLedger(["check", "--project", project, "--json"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.data).toBeNull();
    expect(parsed.error.code).toBe("project_ledger_check_failed");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
