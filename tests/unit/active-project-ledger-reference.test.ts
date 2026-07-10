import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import {
  ActiveProjectLedgerResolutionError,
  ActiveProjectLedgerResolver,
  pathIsContained,
  publicActiveProjectLedgerReference,
} from "../../packages/butler-agent/src/integrations/project-ledger/active-project-ledger-reference.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "butler-active-ledger-"));
  roots.push(value);
  return value;
}

function workspace(name = "workspace-folder", packageName = "sandy-bot"): string {
  const value = join(root(), name);
  mkdirSync(value, { recursive: true });
  writeFileSync(join(value, "package.json"), JSON.stringify({ name: packageName }));
  return value;
}

function ledger(data: string, id: string): string {
  const value = join(data, "project-ledger", "projects", id);
  mkdirSync(value, { recursive: true });
  writeFileSync(join(value, "project.json"), JSON.stringify({ id }));
  writeFileSync(join(value, "ledger.jsonl"), "");
  return value;
}

function appDb(file: string, input: { id?: string; workspacePath: string; updatedAt?: string }): void {
  const db = new Database(file);
  db.run(`CREATE TABLE projects (
    id TEXT NOT NULL, display_name TEXT, workspace_path TEXT, workspace_label TEXT,
    safe_path_label TEXT, archived INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
  )`);
  db.query("INSERT INTO projects VALUES (?, ?, ?, ?, ?, 0, ?)").run(
    input.id ?? "project-sandy-bot-35a0e102",
    "Sandy Bot",
    input.workspacePath,
    "Sandy",
    "sandy-bot",
    input.updatedAt ?? "2026-07-10T00:00:00.000Z",
  );
  db.close(false);
}

test("app id, workspace path/name, omitted ref, and explicit canonical root resolve identically", () => {
  const data = root();
  const work = workspace();
  const canonical = ledger(data, "sandy-bot");
  const dbPath = join(root(), "butler-client.sqlite");
  appDb(dbPath, { workspacePath: work });
  const resolver = new ActiveProjectLedgerResolver();
  const byAppId = resolver.resolve({ butlerData: data, appMessageDbPath: dbPath, appProjectId: "project-sandy-bot-35a0e102" });
  const omitted = resolver.resolve({ butlerData: data, appMessageDbPath: dbPath, appProjectId: "project-sandy-bot-35a0e102", workspacePath: work });
  const byWorkspace = resolver.resolve({ butlerData: data, workspacePath: work });
  const byName = resolver.resolve({ butlerData: data, explicitRef: "sandy-bot" });
  const explicit = resolver.resolve({ butlerData: data, explicitRef: canonical });
  expect([byAppId, omitted, byWorkspace, byName, explicit].map((item) => item.ledger_root)).toEqual(Array(5).fill(canonical));
  expect(byAppId).toMatchObject({ source: "app_project_db", initialized: true, ledger_project_id: "sandy-bot" });
});

test("missing DB degrades through workspace metadata but an unmapped app id fails safely", () => {
  const data = root();
  const work = workspace();
  ledger(data, "sandy-bot");
  const fallback = new ActiveProjectLedgerResolver().resolve({
    butlerData: data,
    appMessageDbPath: join(root(), "missing.sqlite"),
    appProjectId: "project-sandy-bot-35a0e102",
    workspacePath: work,
  });
  expect(fallback).toMatchObject({ ledger_project_id: "sandy-bot", degradation_code: "app_project_db_missing" });
  expect(() => new ActiveProjectLedgerResolver().resolve({
    butlerData: data,
    appMessageDbPath: join(root(), "missing.sqlite"),
    appProjectId: "project-private-path-must-not-leak",
  })).toThrow("active_project_ledger_unresolved");
  try {
    new ActiveProjectLedgerResolver().resolve({ butlerData: data, appProjectId: "/private/secret/project" });
  } catch (error) {
    expect(error).toBeInstanceOf(ActiveProjectLedgerResolutionError);
    expect(JSON.stringify(error)).not.toContain("/private/secret");
  }
});

test("an uninitialized canonical target remains truthful and deterministic ambiguity is diagnostic", () => {
  const data = root();
  const work = workspace();
  const uninitialized = new ActiveProjectLedgerResolver().resolve({ butlerData: data, workspacePath: work });
  expect(uninitialized).toMatchObject({ ledger_project_id: "sandy-bot", initialized: false });

  writeFileSync(join(work, "project.json"), JSON.stringify({ id: "sandy-primary" }));
  ledger(data, "sandy-primary");
  ledger(data, "sandy-bot");
  const ambiguous = new ActiveProjectLedgerResolver().resolve({ butlerData: data, workspacePath: work });
  expect(ambiguous).toMatchObject({ ledger_project_id: "sandy-primary", initialized: true, ambiguity_count: 2 });
});

test("realpath containment rejects a canonical-root symlink escape", () => {
  const data = root();
  const projects = join(data, "project-ledger", "projects");
  mkdirSync(projects, { recursive: true });
  const outside = root();
  writeFileSync(join(outside, "project.json"), JSON.stringify({ id: "escaped" }));
  writeFileSync(join(outside, "ledger.jsonl"), "");
  const escaped = join(projects, "escaped");
  symlinkSync(outside, escaped, "dir");
  expect(() => new ActiveProjectLedgerResolver().resolve({ butlerData: data, explicitRef: escaped }))
    .toThrow("active_project_ledger_path_escape");
});

test("path containment handles POSIX and Windows separators without substring checks", () => {
  expect(pathIsContained("/data/projects", "/data/projects/a", "posix")).toBe(true);
  expect(pathIsContained("/data/projects", "/data/projects-escape/a", "posix")).toBe(false);
  expect(pathIsContained("C:\\data\\projects", "C:\\data\\projects\\a", "win32")).toBe(true);
  expect(pathIsContained("C:\\data\\projects", "C:\\data\\projects-escape\\a", "win32")).toBe(false);
  expect(pathIsContained("C:\\data\\projects", "D:\\data\\projects\\a", "win32")).toBe(false);
});

test("cache is bounded and invalidates on app row generation", () => {
  const data = root();
  const work = workspace();
  ledger(data, "sandy-bot");
  const dbPath = join(root(), "butler-client.sqlite");
  appDb(dbPath, { workspacePath: work });
  const resolver = new ActiveProjectLedgerResolver();
  const first = resolver.resolve({ butlerData: data, appMessageDbPath: dbPath, appProjectId: "project-sandy-bot-35a0e102", now: new Date(0) });
  const cached = resolver.resolve({ butlerData: data, appMessageDbPath: dbPath, appProjectId: "project-sandy-bot-35a0e102", now: new Date(1) });
  expect(cached.resolved_at).toBe(first.resolved_at);
  const db = new Database(dbPath);
  db.run("UPDATE projects SET updated_at = '2026-07-11T00:00:00.000Z'");
  db.close(false);
  const invalidated = resolver.resolve({ butlerData: data, appMessageDbPath: dbPath, appProjectId: "project-sandy-bot-35a0e102", now: new Date(2) });
  expect(invalidated.resolved_at).not.toBe(first.resolved_at);
  for (let index = 0; index < 40; index += 1) {
    resolver.resolve({ butlerData: data, workspacePath: work, appProjectId: `project-${index}`, now: new Date(index + 10) });
  }
  expect(resolver.cacheSize).toBeLessThanOrEqual(32);
});

test("cache revalidates initialization markers created in place", () => {
  const data = root();
  const work = workspace();
  const resolver = new ActiveProjectLedgerResolver();
  const first = resolver.resolve({ butlerData: data, workspacePath: work, now: new Date(0) });
  expect(first.initialized).toBe(false);
  const selected = join(data, "project-ledger", "projects", "sandy-bot");
  mkdirSync(selected, { recursive: true });
  writeFileSync(join(selected, "project.json"), JSON.stringify({ id: "sandy-bot" }));
  writeFileSync(join(selected, "ledger.jsonl"), "");
  const refreshed = resolver.resolve({ butlerData: data, workspacePath: work, now: new Date(1) });
  expect(refreshed).toMatchObject({ initialized: true, ledger_project_id: "sandy-bot" });
  expect(refreshed.resolved_at).not.toBe(first.resolved_at);
});

test("public projection omits private absolute paths", () => {
  const data = root();
  const work = workspace();
  ledger(data, "sandy-bot");
  const reference = new ActiveProjectLedgerResolver().resolve({ butlerData: data, workspacePath: work });
  const projected = publicActiveProjectLedgerReference(reference);
  expect(projected).toMatchObject({ ledger_project_id: "sandy-bot", initialized: true });
  expect(projected).not.toHaveProperty("ledger_root");
  expect(projected).not.toHaveProperty("workspace_path");
  expect(JSON.stringify(projected)).not.toContain(work);
});
