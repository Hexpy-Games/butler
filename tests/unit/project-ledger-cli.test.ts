import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";

const root = process.cwd();
const cliPath = join(root, "packages", "project-ledger", "bin", "project-ledger");
const plPath = join(root, "packages", "project-ledger", "bin", "pl");

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

function runBin(
  binPath: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; input?: string } = {},
): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const project = projectArg(args);
  const defaultEnv = project ? { BUTLER_DATA: testButlerData(project) } : {};
  const result = spawnSync(process.execPath, [binPath, ...args], {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...defaultEnv, ...options.env },
    encoding: "utf8",
    input: options.input,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function runLedger(args: string[], options: { cwd?: string; env?: Record<string, string>; input?: string } = {}): {
  status: number;
  stdout: string;
  stderr: string;
} {
  return runBin(cliPath, args, options);
}

function runPl(args: string[], options: { cwd?: string; env?: Record<string, string>; input?: string } = {}): {
  status: number;
  stdout: string;
  stderr: string;
} {
  return runBin(plPath, args, options);
}

function runLedgerJson(
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; input?: string } = {},
): any {
  const result = runLedger([...args, "--json"], options);
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}

function runPlJson(
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; input?: string } = {},
): any {
  const result = runPl([...args, "--json"], options);
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

function writeSpec(project: string, id: string, frontmatter: Record<string, string>, bodyText = ""): string {
  const dir = join(ledgerProjectRoot(project), "specs");
  mkdirSync(dir, { recursive: true });
  const body = [
    "---",
    ...Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`),
    "---",
    "",
    bodyText || `# ${frontmatter.title ?? id}`,
    "",
  ].join("\n");
  const path = join(dir, `${id.toLowerCase()}.md`);
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
    expect(result.stdout).toContain("project-ledger spec show|update --project PATH --id ID");
    expect(result.stdout).toContain("project-ledger plan create|show|update --project PATH --id ID");
  }
});

test("pl help prints concise workflow aliases", () => {
  const result = runPl(["help"]);
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("Common workflow:");
  expect(result.stdout).toContain("pl create KIND ID --title TITLE");
  expect(result.stdout).toContain("pl complete ID [--kind work|task|attempt]");
  expect(result.stdout).toContain("Use project-ledger help for the full command reference.");
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

test("project-ledger init defaults to repo-local layout when BUTLER_DATA is unset", () => {
  const project = tempProject();
  const fakeHome = mkdtempSync(join(tmpdir(), "project-ledger-standalone-home-"));
  try {
    const result = runLedgerJson([
      "init",
      "--project",
      project,
      "--id",
      "demo",
      "--name",
      "Standalone Demo",
    ], {
      env: { BUTLER_DATA: "", HOME: fakeHome },
    });

    const repoLocal = join(project, ".project-ledger");
    expect(result.data.root).toBe(".project-ledger");
    expect(existsSync(join(repoLocal, "project.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(repoLocal, "project.json"), "utf8")).name).toBe("Standalone Demo");
    expect(existsSync(join(fakeHome, ".butler", "project-ledger", "projects", "demo"))).toBe(false);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("project-ledger init honors explicit BUTLER_DATA over fallback home ledgers", () => {
  const project = tempProject();
  const explicitData = mkdtempSync(join(tmpdir(), "project-ledger-explicit-data-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "project-ledger-fake-home-"));
  const fallbackProject = join(fakeHome, ".butler", "project-ledger", "projects", "demo");
  try {
    mkdirSync(fallbackProject, { recursive: true });
    writeFileSync(
      join(fallbackProject, "project.json"),
      `${JSON.stringify({
        schema: "project-ledger.project.v1",
        id: "demo",
        name: "Fallback Demo",
        status: "active",
      }, null, 2)}\n`,
      "utf8",
    );
    writeFileSync(join(fallbackProject, "ledger.jsonl"), "", "utf8");

    const result = runLedgerJson(
      ["init", "--project", project, "--id", "demo", "--name", "Explicit Demo"],
      { env: { BUTLER_DATA: explicitData, HOME: fakeHome } },
    );

    const explicitProject = ledgerProjectRoot(project, explicitData);
    expect(result.data.root).toBe("project-ledger/projects/demo");
    expect(existsSync(join(explicitProject, "project.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(explicitProject, "project.json"), "utf8")).name).toBe("Explicit Demo");
    expect(JSON.parse(readFileSync(join(fallbackProject, "project.json"), "utf8")).name).toBe("Fallback Demo");
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(explicitData, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("project-ledger resolves fallback home ledger when BUTLER_DATA is unset and live ledger exists", () => {
  const project = tempProject();
  const fakeHome = mkdtempSync(join(tmpdir(), "project-ledger-live-home-"));
  const fallbackProject = join(fakeHome, ".butler", "project-ledger", "projects", "demo");
  try {
    mkdirSync(fallbackProject, { recursive: true });
    writeFileSync(
      join(fallbackProject, "project.json"),
      `${JSON.stringify({
        schema: "project-ledger.project.v1",
        id: "demo",
        name: "Live Home Demo",
        status: "active",
      }, null, 2)}\n`,
      "utf8",
    );
    writeFileSync(join(fallbackProject, "ledger.jsonl"), "", "utf8");
    writeWorkInLedgerRoot(fallbackProject, "W-LIVE-HOME", {
      id: "W-LIVE-HOME",
      kind: "work",
      title: "Live home work",
      status: "in_progress",
      spec: "SPEC-LIVE-HOME",
    });

    const status = runLedgerJson(
      ["status", "--project", project],
      { env: { BUTLER_DATA: "", HOME: fakeHome } },
    );

    expect(status.data.project.name).toBe("Live Home Demo");
    expect(status.data.counts.work).toBe(1);
    expect(status.data.nextActions[0].id).toBe("W-LIVE-HOME");
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("project-ledger keeps existing repo-local ledger when fallback home identity differs", () => {
  const project = tempProject();
  const fakeHome = mkdtempSync(join(tmpdir(), "project-ledger-local-mismatch-home-"));
  const repoLocal = join(project, ".project-ledger");
  const fallbackProject = join(fakeHome, ".butler", "project-ledger", "projects", "demo");
  try {
    mkdirSync(repoLocal, { recursive: true });
    writeFileSync(
      join(repoLocal, "project.json"),
      `${JSON.stringify({
        schema: "project-ledger.project.v1",
        id: "local",
        name: "Local Repo Ledger",
        status: "active",
      }, null, 2)}\n`,
      "utf8",
    );
    writeFileSync(join(repoLocal, "ledger.jsonl"), "", "utf8");
    writeWorkInLedgerRoot(repoLocal, "W-LOCAL", {
      id: "W-LOCAL",
      kind: "work",
      title: "Local work",
      status: "in_progress",
      spec: "SPEC-LOCAL",
    });

    mkdirSync(fallbackProject, { recursive: true });
    writeFileSync(
      join(fallbackProject, "project.json"),
      `${JSON.stringify({
        schema: "project-ledger.project.v1",
        id: "demo",
        name: "Fallback Demo",
        status: "active",
      }, null, 2)}\n`,
      "utf8",
    );
    writeFileSync(join(fallbackProject, "ledger.jsonl"), "", "utf8");
    writeWorkInLedgerRoot(fallbackProject, "W-FALLBACK", {
      id: "W-FALLBACK",
      kind: "work",
      title: "Fallback work",
      status: "in_progress",
      spec: "SPEC-FALLBACK",
    });

    const status = runLedgerJson(
      ["status", "--project", project],
      { env: { BUTLER_DATA: "", HOME: fakeHome } },
    );

    expect(status.data.project.name).toBe("Local Repo Ledger");
    expect(status.data.counts.work).toBe(1);
    expect(status.data.nextActions[0].id).toBe("W-LOCAL");
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
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

test("project-ledger spec update replaces markdown body through the CLI", () => {
  const project = tempProject();
  try {
    runLedgerJson(["init", "--project", project, "--id", "demo", "--name", "Demo Project"]);
    const specPath = writeSpec(project, "SPEC-DEMO", {
      id: "SPEC-DEMO",
      kind: "spec",
      title: "Original Spec",
      status: "active",
    }, "# Original Spec\n\nOld body.");
    runLedgerJson(["index", "--project", project]);

    const bodyPath = join(project, "spec-body.md");
    writeFileSync(bodyPath, "# Updated Spec\n\n## Contract\n\nThe CLI owns spec body updates.\n", "utf8");

    const updated = runLedgerJson([
      "spec",
      "update",
      "--project",
      project,
      "--id",
      "SPEC-DEMO",
      "--title",
      "Updated Spec",
      "--from",
      bodyPath,
    ]);

    expect(updated.data.id).toBe("SPEC-DEMO");
    expect(updated.data.title).toBe("Updated Spec");
    const text = readFileSync(specPath, "utf8");
    expect(text).toContain('title: "Updated Spec"');
    expect(text).toContain("# Updated Spec");
    expect(text).toContain("The CLI owns spec body updates.");
    expect(text).not.toContain("Old body.");
    expect(readFileSync(join(ledgerProjectRoot(project), "ledger.jsonl"), "utf8")).toContain("spec_updated");

    const shown = runLedgerJson(["spec", "show", "--project", project, "--id", "SPEC-DEMO"]);
    expect(shown.data.path).toBe("project-ledger/projects/demo/specs/spec-demo.md");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("project-ledger plan create writes markdown body through the CLI", () => {
  const project = tempProject();
  try {
    runLedgerJson(["init", "--project", project, "--id", "demo", "--name", "Demo Project"]);

    const created = runLedgerJson([
      "plan",
      "create",
      "--project",
      project,
      "--id",
      "PLAN-DEMO",
      "--title",
      "Demo Plan",
      "--spec",
      "SPEC-DEMO",
      "--from",
      "-",
    ], {
      input: "# Demo Plan\n\n## Tasks\n\n- Build the thing.\n",
    });

    expect(created.data.id).toBe("PLAN-DEMO");
    expect(created.data.kind).toBe("plan");
    expect(created.data.path).toBe("project-ledger/projects/demo/plans/plan-demo.md");
    const text = readFileSync(join(ledgerProjectRoot(project), "plans", "plan-demo.md"), "utf8");
    expect(text).toContain('spec: "SPEC-DEMO"');
    expect(text).toContain("# Demo Plan");
    expect(text).toContain("- Build the thing.");
    expect(readFileSync(join(ledgerProjectRoot(project), "ledger.jsonl"), "utf8")).toContain("plan_created");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("project-ledger record CRUD covers modeled top-level source records", () => {
  const project = tempProject();
  try {
    runLedgerJson(["init", "--project", project, "--id", "demo", "--name", "Demo Project"]);
    const cases = [
      ["spec", "SPEC-CRUD"],
      ["plan", "PLAN-CRUD"],
      ["report", "REPORT-CRUD"],
      ["decision", "DECISION-CRUD"],
      ["risk", "RISK-CRUD"],
      ["handoff", "HANDOFF-CRUD"],
      ["reference", "REFERENCE-CRUD"],
      ["roadmap", "ROADMAP-CRUD"],
      ["initiative", "INITIATIVE-CRUD"],
    ];

    for (const [kind, id] of cases) {
      const created = runLedgerJson([
        "record",
        "create",
        "--project",
        project,
        "--kind",
        kind,
        "--id",
        id,
        "--title",
        `${kind} title`,
        "--from",
        "-",
      ], {
        input: `# ${kind} title\n\nOriginal ${kind} body.\n`,
      });
      expect(created.data.kind).toBe(kind);
      expect(created.data.id).toBe(id);

      const shown = runLedgerJson([
        "record",
        "show",
        "--project",
        project,
        "--kind",
        kind,
        "--id",
        id,
        "--body",
      ]);
      expect(shown.data.body).toContain(`Original ${kind} body.`);

      const updated = runLedgerJson([
        "record",
        "update",
        "--project",
        project,
        "--kind",
        kind,
        "--id",
        id,
        "--title",
        `${kind} updated`,
        "--validation",
        "CLI CRUD test",
        "--from",
        "-",
      ], {
        input: `# ${kind} updated\n\nUpdated ${kind} body.\n`,
      });
      expect(updated.data.title).toBe(`${kind} updated`);
      expect(updated.data.validation).toBe("CLI CRUD test");

      const updatedShown = runLedgerJson([
        "record",
        "show",
        "--project",
        project,
        "--id",
        id,
        "--body",
      ]);
      expect(updatedShown.data.body).toContain(`Updated ${kind} body.`);
    }

    const ledger = readFileSync(join(ledgerProjectRoot(project), "ledger.jsonl"), "utf8");
    expect(ledger).toContain('"source":"project-ledger"');
    expect(ledger).toContain("spec_created");
    expect(ledger).toContain("roadmap_updated");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("project-ledger record update preserves unknown frontmatter and rejects empty body input", () => {
  const project = tempProject();
  try {
    runLedgerJson(["init", "--project", project, "--id", "demo", "--name", "Demo Project"]);
    runLedgerJson([
      "record",
      "create",
      "--project",
      project,
      "--kind",
      "decision",
      "--id",
      "DECISION-UNKNOWN",
      "--title",
      "Unknown keys",
      "--from",
      "-",
    ], {
      input: "# Unknown keys\n\nOriginal body.\n",
    });
    const decisionPath = join(ledgerProjectRoot(project), "decisions", "decision-unknown.md");
    const withUnknown = readFileSync(decisionPath, "utf8").replace(
      'status: "accepted"',
      'status: "accepted"\ncustomKey: "keep-me"',
    );
    writeFileSync(decisionPath, withUnknown, "utf8");

    runLedgerJson([
      "record",
      "update",
      "--project",
      project,
      "--kind",
      "decision",
      "--id",
      "DECISION-UNKNOWN",
      "--title",
      "Unknown keys updated",
    ]);
    expect(readFileSync(decisionPath, "utf8")).toContain('customKey: "keep-me"');

    const empty = runLedger([
      "record",
      "update",
      "--project",
      project,
      "--kind",
      "decision",
      "--id",
      "DECISION-UNKNOWN",
      "--from",
      "-",
      "--json",
    ], {
      input: "   \n",
    });
    expect(empty.status).toBe(1);
    expect(JSON.parse(empty.stdout).error.code).toBe("invalid_input");
    expect(readFileSync(decisionPath, "utf8")).toContain("Original body.");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("project-ledger record show and body update support lifecycle source records", () => {
  const project = tempProject();
  try {
    runLedgerJson(["init", "--project", project, "--id", "demo", "--name", "Demo Project"]);
    runLedgerJson([
      "work",
      "create",
      "--project",
      project,
      "--id",
      "W-RECORD-BODY",
      "--title",
      "Record body work",
      "--spec",
      "SPEC-RECORD-BODY",
      "--acceptance",
      "Lifecycle body updates work",
    ]);
    runLedgerJson(["index", "--project", project]);
    runLedgerJson([
      "task",
      "create",
      "--project",
      project,
      "--work",
      "W-RECORD-BODY",
      "--id",
      "T-RECORD-BODY",
      "--title",
      "Record body task",
    ]);
    runLedgerJson(["index", "--project", project]);
    runLedgerJson([
      "attempt",
      "start",
      "--project",
      project,
      "--task",
      "T-RECORD-BODY",
      "--id",
      "A-RECORD-BODY",
      "--title",
      "Record body attempt",
    ]);

    const cases = [
      ["work", "W-RECORD-BODY", join(ledgerProjectRoot(project), "work", "W-RECORD-BODY", "work.md")],
      ["task", "T-RECORD-BODY", join(ledgerProjectRoot(project), "work", "W-RECORD-BODY", "tasks", "T-RECORD-BODY.md")],
      [
        "attempt",
        "A-RECORD-BODY",
        join(
          ledgerProjectRoot(project),
          "work",
          "W-RECORD-BODY",
          "tasks",
          "T-RECORD-BODY",
          "attempts",
          "A-RECORD-BODY.md",
        ),
      ],
    ];

    for (const [kind, id, path] of cases) {
      const body = `# Updated ${kind}\n\nBody for ${id}.\n\n`;
      const updated = runLedgerJson([
        "record",
        "update",
        "--project",
        project,
        "--kind",
        kind,
        "--id",
        id,
        "--from",
        "-",
      ], {
        input: body,
      });
      expect(updated.data.kind).toBe(kind);
      expect(readFileSync(path, "utf8")).toContain(`Body for ${id}.`);

      const shown = runLedgerJson([
        "record",
        "show",
        "--project",
        project,
        "--kind",
        kind,
        "--id",
        id,
        "--body",
      ]);
      expect(shown.data.body).toBe(body);
    }

    const ledger = readFileSync(join(ledgerProjectRoot(project), "ledger.jsonl"), "utf8");
    expect(ledger).toContain("work_updated");
    expect(ledger).toContain("task_updated");
    expect(ledger).toContain("attempt_updated");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("project-ledger lifecycle update commands preserve body input", () => {
  const project = tempProject();
  try {
    runLedgerJson(["init", "--project", project, "--id", "demo", "--name", "Demo Project"]);
    runLedgerJson([
      "work",
      "create",
      "--project",
      project,
      "--id",
      "W-LIFECYCLE-BODY",
      "--title",
      "Lifecycle body work",
      "--spec",
      "SPEC-LIFECYCLE-BODY",
      "--acceptance",
      "Lifecycle update commands write bodies",
    ]);
    runLedgerJson([
      "task",
      "create",
      "--project",
      project,
      "--work",
      "W-LIFECYCLE-BODY",
      "--id",
      "T-LIFECYCLE-BODY",
      "--title",
      "Lifecycle body task",
    ]);
    runLedgerJson([
      "attempt",
      "start",
      "--project",
      project,
      "--task",
      "T-LIFECYCLE-BODY",
      "--id",
      "A-LIFECYCLE-BODY",
      "--title",
      "Lifecycle body attempt",
    ]);

    runLedgerJson([
      "work",
      "update",
      "--project",
      project,
      "--id",
      "W-LIFECYCLE-BODY",
      "--body",
      "# Work Lifecycle Body\n\nUpdated through work update.\n",
    ]);
    const updatedTaskBody = "# Task Lifecycle Body\n\nUpdated through task update.\n";
    runLedgerJson([
      "task",
      "update",
      "--project",
      project,
      "--id",
      "T-LIFECYCLE-BODY",
      "--from",
      "-",
    ], { input: updatedTaskBody });
    runLedgerJson([
      "attempt",
      "succeed",
      "--project",
      project,
      "--id",
      "A-LIFECYCLE-BODY",
      "--body",
      "# Attempt Lifecycle Body\n\nUpdated through attempt succeed.\n",
    ]);

    const work = runLedgerJson([
      "record",
      "show",
      "--project",
      project,
      "--kind",
      "work",
      "--id",
      "W-LIFECYCLE-BODY",
      "--body",
    ]);
    const task = runLedgerJson([
      "record",
      "show",
      "--project",
      project,
      "--kind",
      "task",
      "--id",
      "T-LIFECYCLE-BODY",
      "--body",
    ]);
    const attempt = runLedgerJson([
      "record",
      "show",
      "--project",
      project,
      "--kind",
      "attempt",
      "--id",
      "A-LIFECYCLE-BODY",
      "--body",
    ]);

    expect(work.data.body).toContain("Updated through work update.");
    expect(task.data.body).toBe(updatedTaskBody);
    expect(attempt.data.status).toBe("succeeded");
    expect(attempt.data.body).toContain("Updated through attempt succeed.");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("project-ledger lifecycle creates preserve body input", () => {
  const project = tempProject();
  try {
    runLedgerJson(["init", "--project", project, "--id", "demo", "--name", "Demo Project"]);
    runLedgerJson([
      "work",
      "create",
      "--project",
      project,
      "--id",
      "W-CREATE-BODY",
      "--title",
      "Create body work",
      "--spec",
      "SPEC-CREATE-BODY",
      "--acceptance",
      "Lifecycle create body input is stored.",
      "--from",
      "-",
    ], {
      input: "# Work Body\n\nCreated through lifecycle work create.\n",
    });
    runLedgerJson(["index", "--project", project]);
    runLedgerJson([
      "task",
      "create",
      "--project",
      project,
      "--work",
      "W-CREATE-BODY",
      "--id",
      "T-CREATE-BODY",
      "--title",
      "Create body task",
      "--from",
      "-",
    ], {
      input: "# Task Body\n\nCreated through lifecycle task create.\n",
    });
    runLedgerJson(["index", "--project", project]);
    runLedgerJson([
      "attempt",
      "start",
      "--project",
      project,
      "--task",
      "T-CREATE-BODY",
      "--id",
      "A-CREATE-BODY",
      "--title",
      "Create body attempt",
      "--from",
      "-",
    ], {
      input: "# Attempt Body\n\nCreated through lifecycle attempt start.\n",
    });

    expect(runLedgerJson([
      "record",
      "show",
      "--project",
      project,
      "--kind",
      "work",
      "--id",
      "W-CREATE-BODY",
      "--body",
    ]).data.body).toContain("Created through lifecycle work create.");
    expect(runLedgerJson([
      "record",
      "show",
      "--project",
      project,
      "--kind",
      "task",
      "--id",
      "T-CREATE-BODY",
      "--body",
    ]).data.body).toContain("Created through lifecycle task create.");
    expect(runLedgerJson([
      "record",
      "show",
      "--project",
      project,
      "--kind",
      "attempt",
      "--id",
      "A-CREATE-BODY",
      "--body",
    ]).data.body).toContain("Created through lifecycle attempt start.");

    runLedgerJson([
      "work",
      "create",
      "--project",
      project,
      "--id",
      "W-LITERAL-BODY",
      "--title",
      "Literal body work",
      "--spec",
      "SPEC-LITERAL-BODY",
      "--acceptance",
      "Literal --body input is stored.",
      "--body",
      "# Literal Body\n\nCreated through lifecycle work create --body.\n",
    ]);
    expect(runLedgerJson([
      "record",
      "show",
      "--project",
      project,
      "--kind",
      "work",
      "--id",
      "W-LITERAL-BODY",
      "--body",
    ]).data.body).toContain("Created through lifecycle work create --body.");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("project-ledger record update protects work completion gates", () => {
  const project = tempProject();
  try {
    runLedgerJson(["init", "--project", project, "--id", "demo", "--name", "Demo Project"]);
    runLedgerJson([
      "work",
      "create",
      "--project",
      project,
      "--id",
      "W-GENERIC-COMPLETE",
      "--title",
      "Generic completion gate",
      "--spec",
      "SPEC-GENERIC-COMPLETE",
      "--acceptance",
      "Generic update cannot bypass completion gates",
    ]);
    for (const status of ["scoped", "specified", "in_progress", "review"]) {
      runLedgerJson([
        "record",
        "update",
        "--project",
        project,
        "--kind",
        "work",
        "--id",
        "W-GENERIC-COMPLETE",
        "--status",
        status,
      ]);
    }

    const blocked = runLedger([
      "record",
      "update",
      "--project",
      project,
      "--kind",
      "work",
      "--id",
      "W-GENERIC-COMPLETE",
      "--status",
      "done",
      "--json",
    ]);
    expect(blocked.status).toBe(1);
    const blockedJson = JSON.parse(blocked.stdout);
    expect(blockedJson.error.code).toBe("completion_gate_failed");
    expect(blockedJson.error.details.map((item: any) => item.field)).toEqual(["validation", "review", "report"]);

    const afterBlocked = runLedgerJson([
      "record",
      "show",
      "--project",
      project,
      "--kind",
      "work",
      "--id",
      "W-GENERIC-COMPLETE",
    ]);
    expect(afterBlocked.data.status).toBe("review");

    const completed = runLedgerJson([
      "record",
      "update",
      "--project",
      project,
      "--kind",
      "work",
      "--id",
      "W-GENERIC-COMPLETE",
      "--status",
      "done",
      "--validation",
      "generic update validation",
      "--review",
      "generic update review",
      "--report",
      "reports/generic-complete.md",
    ]);
    expect(completed.data.status).toBe("done");
    expect(completed.data.validation).toBe("generic update validation");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("project-ledger record update validates task and attempt transitions", () => {
  const project = tempProject();
  try {
    runLedgerJson(["init", "--project", project, "--id", "demo", "--name", "Demo Project"]);
    runLedgerJson([
      "work",
      "create",
      "--project",
      project,
      "--id",
      "W-LIFECYCLE",
      "--title",
      "Lifecycle work",
      "--spec",
      "SPEC-DEMO",
      "--acceptance",
      "Lifecycle coverage exists",
    ]);
    runLedgerJson([
      "task",
      "create",
      "--project",
      project,
      "--work",
      "W-LIFECYCLE",
      "--id",
      "T-LIFECYCLE",
      "--title",
      "Lifecycle task",
    ]);
    runLedgerJson(["index", "--project", project]);

    const invalidTask = runLedger([
      "record",
      "update",
      "--project",
      project,
      "--kind",
      "task",
      "--id",
      "T-LIFECYCLE",
      "--status",
      "done",
      "--json",
    ]);
    expect(invalidTask.status).toBe(2);
    const invalidTaskJson = JSON.parse(invalidTask.stdout);
    expect(invalidTaskJson.error.code).toBe("invalid_transition");
    expect(invalidTaskJson.error.details).toEqual([{ id: "T-LIFECYCLE", kind: "task", status: "todo" }]);
    expect(invalidTaskJson.error.next.map((item: any) => item.command)).toEqual([
      "project-ledger task update --id T-LIFECYCLE --status in_progress",
      "project-ledger task complete --id T-LIFECYCLE",
    ]);

    const startedTask = runLedgerJson([
      "record",
      "update",
      "--project",
      project,
      "--kind",
      "task",
      "--id",
      "T-LIFECYCLE",
      "--status",
      "in_progress",
    ]);
    expect(startedTask.data.status).toBe("in_progress");
    runLedgerJson(["index", "--project", project]);

    runLedgerJson([
      "attempt",
      "start",
      "--project",
      project,
      "--task",
      "T-LIFECYCLE",
      "--id",
      "A-LIFECYCLE",
      "--title",
      "Lifecycle attempt",
    ]);
    runLedgerJson(["index", "--project", project]);

    const invalidAttempt = runLedger([
      "record",
      "update",
      "--project",
      project,
      "--kind",
      "attempt",
      "--id",
      "A-LIFECYCLE",
      "--status",
      "interrupted",
      "--json",
    ]);
    expect(invalidAttempt.status).toBe(0);
    expect(JSON.parse(invalidAttempt.stdout).data.status).toBe("interrupted");

    const invalidAttemptRetry = runLedger([
      "record",
      "update",
      "--project",
      project,
      "--kind",
      "attempt",
      "--id",
      "A-LIFECYCLE",
      "--status",
      "succeeded",
      "--json",
    ]);
    expect(invalidAttemptRetry.status).toBe(2);
    const invalidAttemptRetryJson = JSON.parse(invalidAttemptRetry.stdout);
    expect(invalidAttemptRetryJson.error.code).toBe("invalid_transition");
    expect(invalidAttemptRetryJson.error.details).toEqual([
      { id: "A-LIFECYCLE", kind: "attempt", status: "interrupted" },
    ]);
    expect(invalidAttemptRetryJson.error.next.map((item: any) => item.command)).toContain(
      "project-ledger attempt start --task T-LIFECYCLE --id A-LIFECYCLE",
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("project-ledger lifecycle errors include concrete JSON next hints for Sandy cases", () => {
  const project = tempProject();
  try {
    runLedgerJson(["init", "--project", project, "--id", "demo", "--name", "Demo Project"]);
    runLedgerJson([
      "work",
      "create",
      "--project",
      project,
      "--id",
      "W-SANDY",
      "--title",
      "Sandy lifecycle work",
      "--status",
      "specified",
      "--spec",
      "SPEC-SANDY",
      "--acceptance",
      "Lifecycle errors are recoverable",
    ]);
    runLedgerJson([
      "task",
      "create",
      "--project",
      project,
      "--work",
      "W-SANDY",
      "--id",
      "T-SANDY",
      "--title",
      "Sandy lifecycle task",
    ]);

    const invalidTaskState = runLedger([
      "task",
      "create",
      "--project",
      project,
      "--work",
      "W-SANDY",
      "--id",
      "T-SPECIFIED",
      "--title",
      "Invalid specified task",
      "--status",
      "specified",
      "--json",
    ]);
    expect(invalidTaskState.status).toBe(2);
    const invalidTaskStateJson = JSON.parse(invalidTaskState.stdout);
    expect(invalidTaskStateJson.error.code).toBe("invalid_state");
    expect(invalidTaskStateJson.error.details).toEqual([{ id: "T-SPECIFIED", kind: "task", status: "specified" }]);
    expect(invalidTaskStateJson.error.next.map((item: any) => item.command)).toContain(
      "project-ledger task create --work W-SANDY --id T-SPECIFIED --status todo",
    );

    const taskIdAsWork = runLedger([
      "work",
      "complete",
      "--project",
      project,
      "--id",
      "T-SANDY",
      "--json",
    ]);
    expect(taskIdAsWork.status).toBe(1);
    const taskIdAsWorkJson = JSON.parse(taskIdAsWork.stdout);
    expect(taskIdAsWorkJson.error.code).toBe("record_not_found");
    expect(taskIdAsWorkJson.error.details).toEqual([{ id: "T-SANDY", kind: "work" }]);
    expect(taskIdAsWorkJson.error.next.map((item: any) => item.command)).toContain(
      "project-ledger record show --kind work --id T-SANDY",
    );

    const taskTodoDone = runLedger([
      "task",
      "complete",
      "--project",
      project,
      "--id",
      "T-SANDY",
      "--json",
    ]);
    expect(taskTodoDone.status).toBe(2);
    const taskTodoDoneJson = JSON.parse(taskTodoDone.stdout);
    expect(taskTodoDoneJson.error.code).toBe("invalid_transition");
    expect(taskTodoDoneJson.error.details).toEqual([{ id: "T-SANDY", kind: "task", status: "todo" }]);
    expect(taskTodoDoneJson.error.next.map((item: any) => item.command)).toEqual([
      "project-ledger task update --id T-SANDY --status in_progress",
      "project-ledger task complete --id T-SANDY",
    ]);

    const workSpecifiedDone = runLedger([
      "work",
      "complete",
      "--project",
      project,
      "--id",
      "W-SANDY",
      "--json",
    ]);
    expect(workSpecifiedDone.status).toBe(2);
    const workSpecifiedDoneJson = JSON.parse(workSpecifiedDone.stdout);
    expect(workSpecifiedDoneJson.error.code).toBe("invalid_transition");
    expect(workSpecifiedDoneJson.error.details).toEqual([{ id: "W-SANDY", kind: "work", status: "specified" }]);
    expect(workSpecifiedDoneJson.error.next.map((item: any) => item.command)).toContain(
      "project-ledger work update --id W-SANDY --status in_progress",
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("project-ledger record resolution errors include concrete JSON next hints", () => {
  const project = tempProject();
  try {
    runLedgerJson(["init", "--project", project, "--id", "demo", "--name", "Demo Project"]);
    runLedgerJson([
      "work",
      "create",
      "--project",
      project,
      "--id",
      "DUPLICATE-ID",
      "--title",
      "Duplicate work",
      "--spec",
      "SPEC-DUPLICATE",
      "--acceptance",
      "Ambiguous ids are recoverable",
    ]);
    runLedgerJson([
      "record",
      "create",
      "--project",
      project,
      "--kind",
      "reference",
      "--id",
      "DUPLICATE-ID",
      "--title",
      "Duplicate reference",
    ]);

    const missing = runLedger([
      "record",
      "show",
      "--project",
      project,
      "--kind",
      "task",
      "--id",
      "T-MISSING",
      "--json",
    ]);
    expect(missing.status).toBe(1);
    const missingJson = JSON.parse(missing.stdout);
    expect(missingJson.error.code).toBe("record_not_found");
    expect(missingJson.error.next.map((item: any) => item.command)).toContain(
      "project-ledger query --kind task",
    );

    const ambiguous = runLedger([
      "record",
      "show",
      "--project",
      project,
      "--id",
      "DUPLICATE-ID",
      "--json",
    ]);
    expect(ambiguous.status).toBe(1);
    const ambiguousJson = JSON.parse(ambiguous.stdout);
    expect(ambiguousJson.error.code).toBe("ambiguous_record");
    expect(ambiguousJson.error.details.map((item: any) => item.kind).sort()).toEqual(["reference", "work"]);
    expect(ambiguousJson.error.next.map((item: any) => item.command).sort()).toEqual([
      "project-ledger record show --kind reference --id DUPLICATE-ID",
      "project-ledger record show --kind work --id DUPLICATE-ID",
    ]);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("project-ledger record create rejects path traversal ids", () => {
  const project = tempProject();
  try {
    runLedgerJson(["init", "--project", project, "--id", "demo", "--name", "Demo Project"]);

    const result = runLedger([
      "record",
      "create",
      "--project",
      project,
      "--kind",
      "spec",
      "--id",
      "../escape",
      "--title",
      "Escape",
      "--from",
      "-",
      "--json",
    ], {
      input: "# Escape\n",
    });

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).error.code).toBe("invalid_input");
    expect(existsSync(join(ledgerProjectRoot(project), "escape.md"))).toBe(false);
    expect(existsSync(join(ledgerProjectRoot(project), "specs", "..", "escape.md"))).toBe(false);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("project-ledger record body replacement preserves input exactly", () => {
  const project = tempProject();
  try {
    runLedgerJson(["init", "--project", project, "--id", "demo", "--name", "Demo Project"]);
    const body = "# Exact Body\n\nLine with spaces  \n\n";
    runLedgerJson([
      "record",
      "create",
      "--project",
      project,
      "--kind",
      "reference",
      "--id",
      "REF-EXACT",
      "--title",
      "Exact Body",
      "--from",
      "-",
    ], {
      input: body,
    });

    const shown = runLedgerJson([
      "record",
      "show",
      "--project",
      project,
      "--kind",
      "reference",
      "--id",
      "REF-EXACT",
      "--body",
    ]);
    expect(shown.data.body).toBe(body);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("pl create edit show and list route through project-ledger record and query handlers", () => {
  const project = tempProject();
  try {
    runLedgerJson(["init", "--project", project, "--id", "demo", "--name", "Demo Project"]);

    const created = runPlJson([
      "create",
      "reference",
      "REF-SHORT",
      "--project",
      project,
      "--title",
      "Short Reference",
      "--from",
      "-",
    ], {
      input: "# Short Reference\n\nCreated through pl.\n",
    });
    expect(created.command).toBe("pl record");
    expect(created.data.kind).toBe("reference");
    expect(created.data.id).toBe("REF-SHORT");

    const edited = runPlJson([
      "edit",
      "REF-SHORT",
      "--project",
      project,
      "--kind",
      "reference",
      "--title",
      "Edited Short Reference",
      "--validation",
      "pl edit exercised",
      "--from",
      "-",
    ], {
      input: "# Edited Short Reference\n\nUpdated through pl.\n",
    });
    expect(edited.data.title).toBe("Edited Short Reference");
    expect(edited.data.validation).toBe("pl edit exercised");

    const shown = runPlJson(["show", "REF-SHORT", "--project", project, "--kind", "reference", "--body"]);
    expect(shown.data.body).toContain("Updated through pl.");

    const listed = runPlJson(["list", "reference", "--project", project, "--status", "active"]);
    expect(listed.command).toBe("pl query");
    expect(listed.data.results.map((item: any) => item.id)).toEqual(["REF-SHORT"]);

    const status = runPlJson(["status", "--project", project]);
    expect(status.command).toBe("pl status");
    expect(status.data.counts.reference).toBe(1);

    const longShown = runLedgerJson([
      "record",
      "show",
      "--project",
      project,
      "--kind",
      "reference",
      "--id",
      "REF-SHORT",
      "--body",
    ]);
    expect(shown.data).toEqual(longShown.data);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("pl lifecycle aliases route through project-ledger record transition handling", () => {
  const project = tempProject();
  try {
    runLedgerJson(["init", "--project", project, "--id", "demo", "--name", "Demo Project"]);
    runPlJson([
      "create",
      "work",
      "W-SHORT-LIFE",
      "--project",
      project,
      "--title",
      "Short lifecycle work",
      "--spec",
      "SPEC-SHORT-LIFE",
      "--acceptance",
      "Short lifecycle aliases are equivalent",
      "--status",
      "specified",
    ]);

    expect(runPlJson(["start", "W-SHORT-LIFE", "--project", project, "--kind", "work"]).data.status).toBe("in_progress");
    expect(runPlJson(["review", "W-SHORT-LIFE", "--project", project, "--kind", "work"]).data.status).toBe("review");
    const completed = runPlJson([
      "complete",
      "W-SHORT-LIFE",
      "--project",
      project,
      "--kind",
      "work",
      "--validation",
      "pl lifecycle validation",
      "--review",
      "pl lifecycle review",
      "--report",
      "reports/pl-lifecycle.md",
    ]);
    expect(completed.data.status).toBe("done");
    expect(readFileSync(join(ledgerProjectRoot(project), "ledger.jsonl"), "utf8")).toContain("work_completed");

    runPlJson([
      "create",
      "task",
      "T-SHORT-BLOCK",
      "--project",
      project,
      "--parent",
      "W-SHORT-LIFE",
      "--title",
      "Short block task",
    ]);
    const blocked = runPlJson([
      "block",
      "T-SHORT-BLOCK",
      "--project",
      project,
      "--kind",
      "task",
      "--reason",
      "Waiting on dependency",
    ]);
    expect(blocked.data.status).toBe("blocked");
    expect(blocked.data.reason).toBe("Waiting on dependency");

    runPlJson([
      "create",
      "task",
      "T-SHORT-CANCEL",
      "--project",
      project,
      "--parent",
      "W-SHORT-LIFE",
      "--title",
      "Short cancel task",
    ]);
    const cancelled = runPlJson([
      "cancel",
      "T-SHORT-CANCEL",
      "--project",
      project,
      "--kind",
      "task",
      "--reason",
      "No longer needed",
    ]);
    expect(cancelled.data.status).toBe("cancelled");
    expect(cancelled.data.reason).toBe("No longer needed");

    runLedgerJson(["index", "--project", project]);
    runPlJson([
      "create",
      "attempt",
      "A-SHORT-COMPLETE",
      "--project",
      project,
      "--parent",
      "T-SHORT-BLOCK",
      "--title",
      "Short complete attempt",
    ]);
    expect(runPlJson([
      "start",
      "A-SHORT-COMPLETE",
      "--project",
      project,
      "--kind",
      "attempt",
    ]).data.status).toBe("started");
    expect(readFileSync(join(ledgerProjectRoot(project), "ledger.jsonl"), "utf8")).toContain("attempt_started");
    const attempt = runPlJson([
      "complete",
      "A-SHORT-COMPLETE",
      "--project",
      project,
      "--report",
      "reports/pl-attempt.md",
    ]);
    expect(attempt.data.status).toBe("succeeded");
    expect(readFileSync(join(ledgerProjectRoot(project), "ledger.jsonl"), "utf8")).toContain("attempt_succeeded");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("pl index render and check route through project-ledger maintenance handlers", () => {
  const project = tempProject();
  try {
    runLedgerJson(["init", "--project", project, "--id", "demo", "--name", "Demo Project"]);
    runLedgerJson([
      "work",
      "create",
      "--project",
      project,
      "--id",
      "W-SHORT-MAINT",
      "--title",
      "Short maintenance work",
      "--spec",
      "SPEC-SHORT-MAINT",
      "--acceptance",
      "Maintenance aliases work",
    ]);

    expect(runPlJson(["index", "--project", project]).command).toBe("pl index");
    for (const view of ["dashboard", "handoff", "roadmap"]) {
      const rendered = runPlJson(["render", view, "--project", project, "--write"]);
      expect(rendered.command).toBe("pl render");
      expect(rendered.data.path).toContain(`views/${view}.md`);
    }
    runPlJson(["index", "--project", project]);
    const checked = runPlJson(["check", "--project", project]);
    expect(checked.command).toBe("pl check");
    expect(checked.ok).toBe(true);
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

test("project-ledger doctor failed --json preserves diagnostic issues", () => {
  const project = tempProject();
  try {
    runLedgerJson(["init", "--project", project, "--id", "demo", "--name", "Demo Project"]);
    writeWork(project, "W-0001", {
      id: "W-0001",
      kind: "work",
      title: "Missing spec work",
      status: "in_progress",
    });

    const result = runLedger(["doctor", "--project", project, "--fail-on-warning", "--json"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout);
    const errorCount = parsed.data.issues.filter((issue: any) => issue.severity === "error").length;
    const warningCount = parsed.data.issues.filter((issue: any) => issue.severity === "warning").length;
    expect(parsed.ok).toBe(false);
    expect(parsed.data.issues.map((issue: any) => issue.code)).toContain("missing_spec");
    expect(parsed.error.code).toBe("project_ledger_doctor_failed");
    expect(parsed.error.details).toEqual([{ issueCount: parsed.data.issues.length, errorCount, warningCount }]);
    expect(parsed.error.next.map((item: any) => item.command)).toContain(
      `project-ledger doctor --project ${project} --verbose`,
    );
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
    const errorCount = parsed.data.issues.filter((issue: any) => issue.severity === "error").length;
    const warningCount = parsed.data.issues.filter((issue: any) => issue.severity === "warning").length;
    expect(parsed.ok).toBe(false);
    expect(parsed.data.ok).toBe(false);
    expect(parsed.data.issues.map((issue: any) => issue.code)).toContain("missing_spec");
    expect(parsed.error.code).toBe("project_ledger_check_failed");
    expect(parsed.error.details).toEqual([{ issueCount: parsed.data.issues.length, errorCount, warningCount }]);
    expect(parsed.error.next.map((item: any) => item.command)).toContain(
      `project-ledger check --project ${project} --verbose`,
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("project-ledger status query and render rebuild stale task state from source", () => {
  const project = tempProject();
  try {
    runLedgerJson(["init", "--project", project, "--id", "demo", "--name", "Demo Project"]);
    runLedgerJson([
      "work",
      "create",
      "--project",
      project,
      "--id",
      "W-SANDY-STALE",
      "--title",
      "Sandy stale index work",
      "--status",
      "specified",
      "--spec",
      "SPEC-PROJECT-LEDGER",
      "--acceptance",
      "Sandy stale task state is repaired from source",
    ]);
    runLedgerJson([
      "task",
      "create",
      "--project",
      project,
      "--work",
      "W-SANDY-STALE",
      "--id",
      "T-SANDY-STALE",
      "--title",
      "Sandy stale task",
    ]);
    runLedgerJson(["index", "--project", project]);

    const indexPath = join(ledgerProjectRoot(project), "index", "project.json");
    const past = new Date(Date.now() - 5000);
    utimesSync(indexPath, past, past);
    writeTask(project, "W-SANDY-STALE", "T-SANDY-STALE", {
      schema: "project-ledger.task.v1",
      kind: "task",
      id: "T-SANDY-STALE",
      title: "Sandy stale task",
      status: "done",
      parentId: "W-SANDY-STALE",
      validation: "source task is done",
      review: "source task is done",
      report: "reports/sandy-stale-task.md",
    });

    const status = runLedgerJson(["status", "--project", project]);
    expect(JSON.stringify(status.data.nextActions)).not.toContain("T-SANDY-STALE");

    const todoTasks = runLedgerJson(["query", "--project", project, "--kind", "task", "--status", "todo"]);
    expect(JSON.stringify(todoTasks.data.results)).not.toContain("T-SANDY-STALE");

    const taskRecords = runLedgerJson(["query", "--project", project, "--kind", "task"]);
    expect(taskRecords.data.results).toContainEqual(expect.objectContaining({
      id: "T-SANDY-STALE",
      status: "done",
    }));

    const rendered = runLedgerJson(["render", "--project", project, "dashboard", "--write"]);
    expect(rendered.data.markdown).not.toContain("T-SANDY-STALE [todo]");
    expect(readFileSync(join(ledgerProjectRoot(project), "views", "dashboard.md"), "utf8")).not.toContain(
      "T-SANDY-STALE [todo]",
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
