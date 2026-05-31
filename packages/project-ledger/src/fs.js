import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { LEDGER_DIR } from "./constants.js";
import { CliError, nowIso } from "./errors.js";

function safeProjectSegment(value) {
  const safe = String(value ?? "")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return safe ? safe.slice(0, 96) : "project";
}

function butlerDataCandidates() {
  const fallback = join(homedir(), ".butler");
  return [...new Set([process.env.BUTLER_DATA, fallback].filter(Boolean))];
}

function externalLedgerRepoCandidates() {
  return [...new Set([
    process.env.PROJECT_LEDGER_REPO,
    process.env.BUTLER_PROJECT_LEDGER_REPO,
    ...butlerDataCandidates().map((candidate) => join(candidate, "project-ledger")),
  ].filter(Boolean).map((candidate) => resolve(String(candidate))))];
}

function readProjectId(root) {
  const projectFile = join(root, "project.json");
  if (!existsSync(projectFile)) return null;
  try {
    const data = JSON.parse(readFileSync(projectFile, "utf8"));
    return typeof data.id === "string" && data.id.trim() ? data.id.trim() : null;
  } catch {
    return null;
  }
}

function readPackageProjectId(project) {
  const packageFile = join(project, "package.json");
  if (!existsSync(packageFile)) return null;
  try {
    const data = JSON.parse(readFileSync(packageFile, "utf8"));
    return typeof data.name === "string" && data.name.trim() ? data.name.trim() : null;
  } catch {
    return null;
  }
}

function isLedgerRoot(path) {
  return existsSync(join(path, "project.json")) && existsSync(join(path, "ledger.jsonl"));
}

function projectIdCandidates(project) {
  return [
    readProjectId(join(project, LEDGER_DIR)),
    readPackageProjectId(project),
    basename(project),
  ].filter((value, index, values) => value && values.indexOf(value) === index);
}

function externalLedgerRoot(project) {
  for (const id of projectIdCandidates(project)) {
    for (const ledgerRepo of externalLedgerRepoCandidates()) {
      const candidate = join(ledgerRepo, "projects", safeProjectSegment(id));
      if (isLedgerRoot(candidate)) return candidate;
    }
  }
  return null;
}

export function ledgerRoot(project) {
  const resolvedProject = resolve(project);
  if (isLedgerRoot(resolvedProject)) return resolvedProject;
  return externalLedgerRoot(resolvedProject) ?? join(resolvedProject, LEDGER_DIR);
}

export function projectRelative(project, path) {
  const root = ledgerRoot(project);
  const fromLedgerRoot = relative(root, path).split("\\").join("/");
  if (
    fromLedgerRoot &&
    fromLedgerRoot !== ".." &&
    !fromLedgerRoot.startsWith("../") &&
    !isAbsolute(fromLedgerRoot)
  ) {
    return `${LEDGER_DIR}/${fromLedgerRoot}`;
  }
  return relative(project, path).split("\\").join("/");
}

export function projectPath(project, path) {
  const normalized = path.split("\\").join("/");
  if (normalized === LEDGER_DIR) return ledgerRoot(project);
  const prefix = `${LEDGER_DIR}/`;
  if (normalized.startsWith(prefix)) return join(ledgerRoot(project), normalized.slice(prefix.length));
  return join(project, path);
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

export function requireLedger(project) {
  if (!existsSync(ledgerRoot(project))) {
    throw new CliError(`Project Ledger not initialized at ${project}`, "not_initialized", 1);
  }
}

export function safeReadJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new CliError(
      `Invalid JSON at ${path}: ${error instanceof Error ? error.message : "unknown error"}`,
      "invalid_json",
      1,
    );
  }
}

export function safeWriteJson(path, value) {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function appendLedgerEvent(project, event) {
  appendFileSync(join(ledgerRoot(project), "ledger.jsonl"), `${JSON.stringify({
    schema: "project-ledger.event.v1",
    ts: nowIso(),
    ...event,
  })}\n`, "utf8");
}

export function listFiles(root, options = {}) {
  if (!existsSync(root)) return [];
  const files = [];
  for (const entry of readdirSync(root)) {
    const fullPath = join(root, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      if (options.skipDirs?.has(entry)) continue;
      files.push(...listFiles(fullPath, options));
    } else if (stats.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

export function copyDirectory(source, target) {
  ensureDir(target);
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, targetPath);
    } else if (entry.isFile()) {
      writeFileSync(targetPath, readFileSync(sourcePath));
    }
  }
}

export function replaceWithSymlink(source, target) {
  rmSync(target, { recursive: true, force: true });
  ensureDir(dirname(target));
  symlinkSync(source, target, "dir");
}
