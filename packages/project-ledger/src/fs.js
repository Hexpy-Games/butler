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
import { LAYOUT_DIRS } from "./constants.js";
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
  const configured = typeof process.env.BUTLER_DATA === "string" && process.env.BUTLER_DATA.trim()
    ? process.env.BUTLER_DATA.trim()
    : null;
  return configured ? [configured] : [fallback];
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

function repoLocalLedgerRoot(project) {
  return join(project, ".project-ledger");
}

function readRepoLocalProjectId(project) {
  return readProjectId(repoLocalLedgerRoot(project));
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

function isPathInside(root, path) {
  const rel = relative(root, path).split("\\").join("/");
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
}

function projectIdCandidates(project) {
  return [
    readProjectId(project),
    readRepoLocalProjectId(project),
    readPackageProjectId(project),
    basename(project),
  ].filter((value, index, values) => value && values.indexOf(value) === index);
}

function externalLedgerRoot(project, ids = projectIdCandidates(project)) {
  for (const id of ids) {
    for (const ledgerRepo of externalLedgerRepoCandidates()) {
      const candidate = join(ledgerRepo, "projects", safeProjectSegment(id));
      if (isLedgerRoot(candidate)) return candidate;
    }
  }
  return null;
}

function externalLedgerRootFromProjectPath(project) {
  for (const butlerData of butlerDataCandidates().map((candidate) => resolve(String(candidate)))) {
    const projectsRoot = join(butlerData, "project-ledger", "projects");
    if (!isPathInside(projectsRoot, project)) continue;
    const [id] = relative(projectsRoot, project).split("\\").join("/").split("/");
    if (id) return join(projectsRoot, id);
  }
  return null;
}

function defaultLedgerRoot(project) {
  const configured = typeof process.env.BUTLER_DATA === "string" && process.env.BUTLER_DATA.trim()
    ? resolve(process.env.BUTLER_DATA.trim())
    : null;
  if (!configured) return repoLocalLedgerRoot(project);
  const butlerData = configured;
  const [id] = projectIdCandidates(project);
  return join(butlerData, "project-ledger", "projects", safeProjectSegment(id));
}

export function ledgerRoot(project) {
  const resolvedProject = resolve(project);
  if (isLedgerRoot(resolvedProject)) return resolvedProject;
  const externalFromPath = externalLedgerRootFromProjectPath(resolvedProject);
  if (externalFromPath) return externalFromPath;
  const repoLocal = repoLocalLedgerRoot(resolvedProject);
  if (isLedgerRoot(repoLocal)) {
    const repoLocalId = readProjectId(repoLocal);
    const matchingExternal = repoLocalId ? externalLedgerRoot(resolvedProject, [repoLocalId]) : null;
    return matchingExternal ?? repoLocal;
  }
  const external = externalLedgerRoot(resolvedProject);
  if (external) return external;
  return defaultLedgerRoot(resolvedProject);
}

export function ledgerDisplayPrefix(project) {
  const resolvedProject = resolve(project);
  const root = ledgerRoot(resolvedProject);
  const repoLocal = repoLocalLedgerRoot(resolvedProject);
  if (root === repoLocal || basename(root) === ".project-ledger") {
    return ".project-ledger";
  }

  for (const butlerData of butlerDataCandidates().map((candidate) => resolve(String(candidate)))) {
    const projectsRoot = join(butlerData, "project-ledger", "projects");
    if (isPathInside(projectsRoot, root)) {
      return relative(butlerData, root).split("\\").join("/");
    }
  }

  for (const ledgerRepo of externalLedgerRepoCandidates()) {
    const projectsRoot = join(ledgerRepo, "projects");
    if (isPathInside(projectsRoot, root)) {
      const rel = relative(ledgerRepo, root).split("\\").join("/");
      return rel.startsWith("projects/") ? `project-ledger/${rel}` : rel;
    }
  }

  return `project-ledger/projects/${safeProjectSegment(readProjectId(root) ?? basename(root))}`;
}

function isLedgerRootRelativePath(path) {
  const normalized = path.split("\\").join("/");
  if (normalized === "project.json" || normalized === "ledger.jsonl") return true;
  const [head] = normalized.split("/");
  return LAYOUT_DIRS.includes(head);
}

export function projectRelative(project, path) {
  const root = ledgerRoot(project);
  const fromLedgerRoot = relative(root, path).split("\\").join("/");
  if (isPathInside(root, path)) {
    const prefix = ledgerDisplayPrefix(project);
    return fromLedgerRoot ? `${prefix}/${fromLedgerRoot}` : prefix;
  }
  return relative(project, path).split("\\").join("/");
}

export function projectPath(project, path) {
  const normalized = path.split("\\").join("/");
  const root = ledgerRoot(project);
  const displayPrefix = ledgerDisplayPrefix(project);
  if (normalized === displayPrefix) return root;
  if (normalized.startsWith(`${displayPrefix}/`)) {
    return join(root, normalized.slice(displayPrefix.length + 1));
  }
  const canonicalMatch = normalized.match(/^project-ledger\/projects\/([^/]+)(?:\/(.*))?$/u);
  if (canonicalMatch && canonicalMatch[1] === safeProjectSegment(basename(root))) {
    return canonicalMatch[2] ? join(root, canonicalMatch[2]) : root;
  }
  if (isLedgerRootRelativePath(normalized)) return join(root, normalized);
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
