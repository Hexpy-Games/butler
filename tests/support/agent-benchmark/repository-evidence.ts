import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";
import { boundedText } from "./command.ts";

export const LANDING_EVIDENCE_FILES = [
  "README.md",
  "package.json",
  "packages/butler-agent/package.json",
  "packages/butler-app/client/electron/package.json",
  "packages/project-ledger/package.json",
] as const;

export interface RepositoryEvidenceSnapshot {
  root: string;
  files: readonly string[];
  sha256: string;
}

export interface RepositoryEvidenceFile {
  path: string;
  text: string;
}

export const REPOSITORY_EVIDENCE_NAMESPACE = ".benchmark-input/repository";

export function materializeRepositoryEvidence(
  sourceRoot: string,
  destinationRoot: string,
): RepositoryEvidenceSnapshot {
  const root = resolve(destinationRoot);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const copied: string[] = [];
  const digest = createHash("sha256");
  for (const relativePath of LANDING_EVIDENCE_FILES) {
    const source = resolve(sourceRoot, relativePath);
    if (!existsSync(source)) continue;
    if (!lstatSync(source).isFile()) throw new Error(`Pinned repository evidence source is not a regular file: ${relativePath}`);
    const bytes = readFileSync(source);
    const destination = resolve(root, relativePath);
    mkdirSync(resolve(destination, ".."), { recursive: true });
    copyFileSync(source, destination);
    digest.update(relativePath).update("\0").update(bytes);
    copied.push(relativePath);
  }
  if (copied.length === 0) throw new Error("Pinned repository evidence contains no required files.");
  return { root, files: copied, sha256: digest.digest("hex") };
}

/** Verifies every pinned file and rejects additions/deletions before an arm. */
export function verifyRepositoryEvidence(snapshot: RepositoryEvidenceSnapshot): { ok: boolean; diagnostic: string | null } {
  try {
    const root = resolve(snapshot.root);
    const expected = new Set(snapshot.files);
    const actual = new Set(inventoryOutputFiles(root));
    if (actual.size !== expected.size || [...actual].some((path) => !expected.has(path))) {
      return { ok: false, diagnostic: "Pinned repository evidence file set changed." };
    }
    const digest = createHash("sha256");
    for (const path of snapshot.files) {
      const absolute = resolve(root, path);
      if (!isSafeRelativePath(root, absolute) || !existsSync(absolute) || !lstatSync(absolute).isFile()) {
        return { ok: false, diagnostic: `Pinned repository evidence file is missing: ${path}` };
      }
      const bytes = readFileSync(absolute);
      digest.update(path).update("\0").update(bytes);
    }
    const sha256 = digest.digest("hex");
    return sha256 === snapshot.sha256
      ? { ok: true, diagnostic: null }
      : { ok: false, diagnostic: "Pinned repository evidence bytes changed." };
  } catch (error) {
    return { ok: false, diagnostic: redactEvidenceDiagnostic(error instanceof Error ? error.message : String(error)) };
  }
}

/** Reads the exact snapshot bytes for Butler's isolated Electron project workspace. */
export function readRepositoryEvidenceFiles(
  root: string,
  namespace = REPOSITORY_EVIDENCE_NAMESPACE,
): RepositoryEvidenceFile[] {
  const resolvedRoot = resolve(root);
  if (!existsSync(resolvedRoot)) return [];
  if (!isSafeNamespace(namespace)) throw new Error("Repository evidence namespace must be relative and traversal-free.");
  return inventoryOutputFiles(resolvedRoot).map((path) => ({
    path: `${namespace.replaceAll("\\", "/").replace(/\/$/u, "")}/${path.replaceAll("\\", "/")}`,
    text: readFileSync(resolve(resolvedRoot, path), "utf8"),
  }));
}

/** Materializes the immutable repository snapshot inside an external arm's
 * output workspace. The namespace is part of the arm input, never a generated
 * deliverable, and is verified again after the adapter exits. */
export function materializeEvidenceWorkspace(
  snapshot: RepositoryEvidenceSnapshot,
  workspaceRoot: string,
  namespace = REPOSITORY_EVIDENCE_NAMESPACE,
): string {
  if (!isSafeNamespace(namespace)) throw new Error("Repository evidence namespace is unsafe.");
  const workspace = resolve(workspaceRoot);
  const namespaceRoot = resolve(workspace, namespace);
  mkdirSync(namespaceRoot, { recursive: true });
  if (existsSync(namespaceRoot) && inventoryOutputFiles(namespaceRoot).length > 0) {
    const existing = verifyEvidenceWorkspace(snapshot, workspace, namespace);
    if (!existing.ok) throw new Error(existing.diagnostic ?? "External workspace repository evidence already exists with different bytes.");
    return namespaceRoot;
  }
  for (const path of snapshot.files) {
    const source = resolve(snapshot.root, path);
    if (!isSafeRelativePath(snapshot.root, source) || !existsSync(source) || !lstatSync(source).isFile()) {
      throw new Error(`Pinned repository evidence file is missing: ${path}`);
    }
    const destination = resolve(namespaceRoot, path);
    if (!isSafeRelativePath(namespaceRoot, destination)) throw new Error("Repository evidence destination escaped its namespace.");
    mkdirSync(resolve(destination, ".."), { recursive: true });
    copyFileSync(source, destination);
  }
  const verified = verifyEvidenceWorkspace(snapshot, workspace, namespace);
  if (!verified.ok) throw new Error(verified.diagnostic ?? "External workspace repository evidence failed verification.");
  return namespaceRoot;
}

/** Verifies the Electron project workspace received the immutable snapshot in
 * the read-only input namespace before generated artifacts are accepted. */
export function verifyEvidenceWorkspace(
  snapshot: RepositoryEvidenceSnapshot,
  workspaceRoot: string,
  namespace = REPOSITORY_EVIDENCE_NAMESPACE,
): { ok: boolean; diagnostic: string | null } {
  try {
    if (!isSafeNamespace(namespace)) return { ok: false, diagnostic: "Repository evidence namespace is unsafe." };
    const workspace = resolve(workspaceRoot);
    const namespaceRoot = resolve(workspace, namespace);
    const expected = new Set(snapshot.files.map((path) => `${namespace.replaceAll("\\", "/").replace(/\/$/u, "")}/${path.replaceAll("\\", "/")}`));
    const actual = new Set(
      existsSync(namespaceRoot)
        ? inventoryOutputFiles(namespaceRoot).map((path) => `${namespace.replaceAll("\\", "/").replace(/\/$/u, "")}/${path.replaceAll("\\", "/")}`)
        : [],
    );
    if (actual.size !== expected.size || [...actual].some((path) => !expected.has(path))) {
      return { ok: false, diagnostic: "Butler workspace repository evidence file set changed." };
    }
    for (const path of snapshot.files) {
      const source = resolve(snapshot.root, path);
      const destination = resolve(namespaceRoot, path);
      if (!isSafeRelativePath(snapshot.root, source) || !isSafeRelativePath(namespaceRoot, destination) ||
        !existsSync(source) || !existsSync(destination) || !lstatSync(source).isFile() || !lstatSync(destination).isFile() ||
        !readFileSync(source).equals(readFileSync(destination))) {
        return { ok: false, diagnostic: `Butler workspace repository evidence bytes changed: ${path}` };
      }
    }
    return { ok: true, diagnostic: null };
  } catch (error) {
    return { ok: false, diagnostic: redactEvidenceDiagnostic(error instanceof Error ? error.message : String(error)) };
  }
}

export function inventoryOutputFiles(root: string): string[] {
  const output: string[] = [];
  walk(root, root, output);
  return output.sort();
}

function walk(root: string, current: string, output: string[]): void {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlink in benchmark output is not allowed: ${entry.name}`);
    if (entry.isDirectory()) walk(root, path, output);
    else if (entry.isFile()) {
      const relativePath = relative(root, path);
      if (relativePath === ".." || relativePath.startsWith("../")) throw new Error("Output inventory escaped its root");
      output.push(relativePath);
    }
  }
}

function isSafeRelativePath(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== ".." && !rel.startsWith("../") && !rel.includes("\0");
}

function isSafeNamespace(value: string): boolean {
  return value.length > 0 && !value.startsWith("/") && !/^[A-Z]:\\/u.test(value) &&
    !value.split(/[\\/]/u).some((segment) => segment === ".." || segment === "");
}

export function redactEvidenceDiagnostic(value: string): string {
  return boundedText(value).replace(/\$1/gu, "[REDACTED]");
}
