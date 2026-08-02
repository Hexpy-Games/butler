import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { Database } from "bun:sqlite";
import {
  ActiveProjectLedgerResolutionError,
  ActiveProjectLedgerResolver,
  pathIsContained,
  publicActiveProjectLedgerReference,
} from "../../packages/butler-agent/src/integrations/project-ledger/active-project-ledger-reference.ts";
import { ensureActiveProjectLedger } from
  "../../packages/butler-agent/src/integrations/project-ledger/ensure-active-project-ledger.ts";
import { migrateAppStoreSchema } from
  "../../packages/butler-agent/src/gateways/app/infrastructure/core/schema.ts";

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

function appDb(file: string, input: {
  id?: string;
  ledgerProjectId?: string;
  workspacePath: string;
  updatedAt?: string;
}): void {
  const db = new Database(file);
  db.run(`CREATE TABLE projects (
    id TEXT NOT NULL, display_name TEXT, workspace_path TEXT, workspace_label TEXT,
    safe_path_label TEXT, ledger_project_id TEXT,
    archived INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
  )`);
  const id = input.id ?? "project-sandy-bot-35a0e102";
  db.query("INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, 0, ?)").run(
    id,
    "Sandy Bot",
    input.workspacePath,
    "Sandy",
    "sandy-bot",
    input.ledgerProjectId ?? (input.id ? id : "sandy-bot"),
    input.updatedAt ?? "2026-07-10T00:00:00.000Z",
  );
  db.close(false);
}

function legacyAppDb(file: string, input: {
  id: string;
  workspacePath: string;
  safePathLabel: string;
}): void {
  const db = new Database(file);
  db.exec(`CREATE TABLE projects (
    id TEXT PRIMARY KEY, display_name TEXT NOT NULL, status TEXT NOT NULL,
    workspace_path TEXT NOT NULL, workspace_label TEXT NOT NULL,
    safe_path_label TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0, error_summary TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  db.query(`INSERT INTO projects VALUES (
    ?, 'Canonical project', 'active', ?, 'Workspace', ?, 0, 0, NULL,
    '2026-01-01', '2026-01-01'
  )`).run(input.id, input.workspacePath, input.safePathLabel);
  db.close(false);
}

test("a durable App binding preserves the initialized legacy Ledger root", () => {
  const data = root();
  const work = workspace();
  const canonical = ledger(data, "sandy-bot");
  const dbPath = join(root(), "butler-client.sqlite");
  appDb(dbPath, { workspacePath: work });
  const resolver = new ActiveProjectLedgerResolver();
  const byAppId = resolver.resolve({ butlerData: data, appMessageDbPath: dbPath, appProjectId: "project-sandy-bot-35a0e102" });
  const omitted = resolver.resolve({ butlerData: data, appMessageDbPath: dbPath, appProjectId: "project-sandy-bot-35a0e102", workspacePath: work });
  const byAppName = resolver.resolve({ butlerData: data, appMessageDbPath: dbPath, explicitRef: "Sandy Bot" });
  const byWorkspace = resolver.resolve({ butlerData: data, workspacePath: work });
  const byName = resolver.resolve({ butlerData: data, explicitRef: "sandy-bot" });
  const explicit = resolver.resolve({ butlerData: data, explicitRef: canonical });
  expect([byAppId, omitted, byAppName].map((item) => item.ledger_root))
    .toEqual(Array(3).fill(canonical));
  expect([byWorkspace, byName, explicit].map((item) => item.ledger_root))
    .toEqual(Array(3).fill(canonical));
  expect(byAppId).toMatchObject({
    source: "app_project_db",
    initialized: true,
    ledger_project_id: "sandy-bot",
  });
});

test("binding migration preserves the initialized root selected by the prior resolver", () => {
  const data = root();
  const work = workspace("workspace-folder", "canonical-ledger");
  const canonical = ledger(data, "canonical-ledger");
  const dbPath = join(root(), "butler-client.sqlite");
  legacyAppDb(dbPath, {
    id: "project-canonical",
    workspacePath: work,
    safePathLabel: "workspace-folder",
  });
  const db = new Database(dbPath);
  migrateAppStoreSchema(db, { butlerData: data });
  db.close(false);

  const reference = new ActiveProjectLedgerResolver().resolve({
    butlerData: data,
    appMessageDbPath: dbPath,
    appProjectId: "project-canonical",
  });
  expect(reference.ledger_project_id).toBe("canonical-ledger");
  expect(reference.ledger_root).toBe(canonical);
  expect(reference.initialized).toBe(true);
});

test("binding migration falls back to App ids for ambiguous initialized roots", () => {
  const data = root();
  const multiWorkspace = workspace("beta", "alpha");
  const sharedAWorkspace = workspace("shared-a", "shared");
  const sharedBWorkspace = workspace("shared-b", "shared");
  ledger(data, "alpha");
  ledger(data, "beta");
  ledger(data, "shared");
  const dbPath = join(root(), "butler-client.sqlite");
  legacyAppDb(dbPath, {
    id: "project-multi",
    workspacePath: multiWorkspace,
    safePathLabel: "beta",
  });
  const db = new Database(dbPath);
  const insert = db.query(`INSERT INTO projects VALUES (
    ?, 'Canonical project', 'active', ?, 'Workspace', ?, 0, 0, NULL,
    '2026-01-01', '2026-01-01'
  )`);
  insert.run("project-a", sharedAWorkspace, "shared");
  insert.run("project-b", sharedBWorkspace, "other");
  migrateAppStoreSchema(db, { butlerData: data });
  const bindings = db.query<{ id: string; ledger_project_id: string }, []>(`
    SELECT id, ledger_project_id FROM projects ORDER BY id
  `).all();
  db.close(false);

  expect(bindings).toEqual([
    { id: "project-a", ledger_project_id: "project-a" },
    { id: "project-b", ledger_project_id: "project-b" },
    { id: "project-multi", ledger_project_id: "project-multi" },
  ]);
});

test("binding migration deduplicates aliases of one physical initialized root", () => {
  const data = root();
  const work = workspace("foo", "Foo");
  const canonical = ledger(data, "foo");
  const alias = join(data, "project-ledger", "projects", "Foo");
  if (!existsSync(alias)) symlinkSync(canonical, alias, "dir");
  const dbPath = join(root(), "butler-client.sqlite");
  legacyAppDb(dbPath, {
    id: "project-physical",
    workspacePath: work,
    safePathLabel: "foo",
  });
  const db = new Database(dbPath);
  migrateAppStoreSchema(db, { butlerData: data });
  const binding = db.query<{ ledger_project_id: string }, []>(`
    SELECT ledger_project_id FROM projects WHERE id = 'project-physical'
  `).get()?.ledger_project_id;
  db.close(false);

  expect(binding).toBe("Foo");
});

test("binding migration does not share one physical Ledger across App projects", () => {
  const data = root();
  const actual = ledger(data, "actual");
  const alias = join(data, "project-ledger", "projects", "alias");
  symlinkSync(actual, alias, "dir");
  const workspaceA = workspace("workspace-a", "actual");
  const workspaceB = workspace("workspace-b", "alias");
  const dbPath = join(root(), "butler-client.sqlite");
  legacyAppDb(dbPath, {
    id: "project-a",
    workspacePath: workspaceA,
    safePathLabel: "actual",
  });
  const db = new Database(dbPath);
  db.query(`INSERT INTO projects VALUES (
    ?, 'Alias project', 'active', ?, 'Alias', ?, 0, 0, NULL,
    '2026-01-02', '2026-01-02'
  )`).run("alias", workspaceB, "alias");
  migrateAppStoreSchema(db, { butlerData: data });
  const bindings = db.query<{ id: string; ledger_project_id: string }, []>(`
    SELECT id, ledger_project_id FROM projects ORDER BY id
  `).all();
  db.close(false);

  expect(bindings).toEqual([
    { id: "alias", ledger_project_id: "alias-ledger-2" },
    { id: "project-a", ledger_project_id: "project-a" },
  ]);
});

test("binding migration never assigns a fallback over an existing Ledger root", () => {
  const data = root();
  ledger(data, "shared");
  ledger(data, "project-a");
  ledger(data, "project-a-ledger-2");
  const workspaceA = workspace("workspace-a", "shared");
  const workspaceB = workspace("workspace-b", "shared");
  const dbPath = join(root(), "butler-client.sqlite");
  legacyAppDb(dbPath, {
    id: "project-a",
    workspacePath: workspaceA,
    safePathLabel: "shared",
  });
  const db = new Database(dbPath);
  db.query(`INSERT INTO projects VALUES (
    ?, 'Shared project', 'active', ?, 'Shared', ?, 0, 0, NULL,
    '2026-01-02', '2026-01-02'
  )`).run("project-b", workspaceB, "other");
  migrateAppStoreSchema(db, { butlerData: data });
  const bindings = db.query<{ id: string; ledger_project_id: string }, []>(`
    SELECT id, ledger_project_id FROM projects ORDER BY id
  `).all();
  db.close(false);

  expect(bindings).toEqual([
    { id: "project-a", ledger_project_id: "project-a-ledger-3" },
    { id: "project-b", ledger_project_id: "project-b" },
  ]);
});

test("exact App project id cannot drift to an initialized workspace-derived Ledger", () => {
  const data = root();
  const work = workspace("project-a-workspace", "shared-web");
  const otherLedger = ledger(data, "shared-web");
  const otherProjectBefore = readFileSync(join(otherLedger, "project.json"), "utf8");
  const otherEventsBefore = readFileSync(join(otherLedger, "ledger.jsonl"), "utf8");
  const dbPath = join(root(), "butler-client.sqlite");
  appDb(dbPath, { id: "project-a", workspacePath: work });
  const aliasCollisionWorkspace = workspace(
    "alias-collision-workspace",
    "shared-web",
  );
  const db = new Database(dbPath);
  db.query("INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, 0, ?)").run(
    "project-b",
    "project-a",
    aliasCollisionWorkspace,
    "project-a",
    "project-a",
    "project-b",
    "2026-07-11T00:00:00.000Z",
  );
  db.query("INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, 0, ?)").run(
    "project-c",
    "project-missing",
    aliasCollisionWorkspace,
    "project-missing",
    "project-missing",
    "project-c",
    "2026-07-12T00:00:00.000Z",
  );
  db.close(false);
  const resolver = new ActiveProjectLedgerResolver();

  const captured = resolver.resolve({
    butlerData: data,
    appMessageDbPath: dbPath,
    appProjectId: "project-a",
    workspacePath: work,
  });
  expect(captured).toMatchObject({
    app_project_id: "project-a",
    ledger_project_id: "project-a",
    ledger_root: join(data, "project-ledger", "projects", "project-a"),
    initialized: false,
  });

  const initialized = ensureActiveProjectLedger({
    resolver,
    butlerHome: process.cwd(),
    butlerData: data,
    lookup: {
      appMessageDbPath: dbPath,
      appProjectId: "project-a",
      workspacePath: work,
    },
    reference: captured,
  });
  expect(initialized).toMatchObject({
    ledger_project_id: "project-a",
    ledger_root: captured.ledger_root,
    initialized: true,
  });
  expect(JSON.parse(readFileSync(
    join(initialized.ledger_root, "project.json"),
    "utf8",
  ))).toMatchObject({ id: "project-a" });
  expect(readFileSync(join(otherLedger, "project.json"), "utf8"))
    .toBe(otherProjectBefore);
  expect(readFileSync(join(otherLedger, "ledger.jsonl"), "utf8"))
    .toBe(otherEventsBefore);
  expect(() => resolver.resolve({
    butlerData: data,
    appMessageDbPath: dbPath,
    appProjectId: "project-missing",
  })).toThrow("active_project_ledger_unresolved");
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

test("explicit initialization uses workspace identity and is idempotent", () => {
  const data = root();
  const work = workspace("fresh-workspace", "fresh-project");
  const resolver = new ActiveProjectLedgerResolver();
  const before = resolver.resolve({ butlerData: data, workspacePath: work });
  expect(before).toMatchObject({
    ledger_project_id: "fresh-project",
    initialized: false,
  });
  expect(existsSync(before.ledger_root)).toBe(false);

  const initialized = ensureActiveProjectLedger({
    resolver,
    butlerHome: process.cwd(),
    butlerData: data,
    lookup: { workspacePath: work },
  });
  expect(initialized).toMatchObject({
    ledger_project_id: "fresh-project",
    ledger_root: before.ledger_root,
    initialized: true,
  });
  expect(JSON.parse(readFileSync(
    join(initialized.ledger_root, "project.json"),
    "utf8",
  ))).toMatchObject({ id: "fresh-project" });
  const projectBeforeReplay = readFileSync(
    join(initialized.ledger_root, "project.json"),
    "utf8",
  );
  const ledgerBeforeReplay = readFileSync(
    join(initialized.ledger_root, "ledger.jsonl"),
    "utf8",
  );

  expect(ensureActiveProjectLedger({
    resolver,
    butlerHome: process.cwd(),
    butlerData: data,
    lookup: { workspacePath: work },
  }).ledger_root).toBe(initialized.ledger_root);
  expect(readFileSync(join(initialized.ledger_root, "project.json"), "utf8"))
    .toBe(projectBeforeReplay);
  expect(readFileSync(join(initialized.ledger_root, "ledger.jsonl"), "utf8"))
    .toBe(ledgerBeforeReplay);
});

test("initialization stays pinned to the captured canonical Ledger identity", () => {
  const data = root();
  const workA = workspace("workspace-a", "canonical-ledger-a");
  const workB = workspace("workspace-b", "canonical-ledger-b");
  const dbPath = join(root(), "butler-client.sqlite");
  appDb(dbPath, { id: "app-session-id", workspacePath: workA });
  const resolver = new ActiveProjectLedgerResolver();
  const captured = resolver.resolve({
    butlerData: data,
    appMessageDbPath: dbPath,
    appProjectId: "app-session-id",
    workspacePath: workA,
  });
  expect(captured).toMatchObject({
    app_project_id: "app-session-id",
    ledger_project_id: "app-session-id",
    initialized: false,
  });

  const db = new Database(dbPath);
  db.query("UPDATE projects SET workspace_path = ?, updated_at = ? WHERE id = ?")
    .run(workB, "2026-07-12T00:00:00.000Z", "app-session-id");
  db.close(false);

  const initialized = ensureActiveProjectLedger({
    resolver,
    butlerHome: process.cwd(),
    butlerData: data,
    lookup: {
      appMessageDbPath: dbPath,
      appProjectId: "app-session-id",
      workspacePath: workB,
    },
    reference: captured,
  });
  expect(initialized).toMatchObject({
    ledger_root: captured.ledger_root,
    app_project_id: "app-session-id",
    display_name: "Sandy Bot",
    workspace_label: "Sandy",
    source: "app_project_db",
  });
  expect(JSON.parse(readFileSync(
    join(initialized.ledger_root, "project.json"),
    "utf8",
  ))).toMatchObject({ id: "app-session-id", name: "Sandy Bot" });
  expect(existsSync(join(
    data,
    "project-ledger",
    "projects",
    "canonical-ledger-b",
  ))).toBe(false);
});

test("initialization rejects a captured root replaced by a symlink escape", () => {
  const data = root();
  const work = workspace("workspace-symlink", "canonical-symlink");
  const resolver = new ActiveProjectLedgerResolver();
  const captured = resolver.resolve({ butlerData: data, workspacePath: work });
  const outside = root();
  mkdirSync(dirname(captured.ledger_root), { recursive: true });
  symlinkSync(outside, captured.ledger_root, "dir");

  expect(() => ensureActiveProjectLedger({
    resolver,
    butlerHome: process.cwd(),
    butlerData: data,
    lookup: { workspacePath: work },
    reference: captured,
  })).toThrow("active_project_ledger_path_escape");
  expect(existsSync(join(outside, "project.json"))).toBe(false);
  expect(existsSync(join(outside, "ledger.jsonl"))).toBe(false);
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
