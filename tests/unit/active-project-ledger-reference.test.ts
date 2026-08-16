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
