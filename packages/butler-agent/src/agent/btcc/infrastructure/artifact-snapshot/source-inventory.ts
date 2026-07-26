import {
  cpSync,
  existsSync,
  lstatSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

export const WORKSPACE_CONTROL_ROOTS = new Set([".git", ".hg", ".jj", ".svn"]);

export function sourceInventory(root: string): string[] {
  const gitInventory = readGitInventory(root);
  return gitInventory ?? readFilesystemInventory(root);
}

export function removeInventoryPayload(root: string): void {
  if (!existsSync(root)) return;
  for (const relativePath of sourceInventory(root).reverse()) {
    const target = inventoryPath(root, relativePath);
    if (!existsSync(target) && !isSymlink(target)) continue;
    rmSync(target, { recursive: true, force: true });
  }
}

export function copyWorkspaceControls(sourceRoot: string, targetRoot: string): void {
  for (const name of WORKSPACE_CONTROL_ROOTS) {
    const source = join(sourceRoot, name);
    if (!existsSync(source) && !isSymlink(source)) continue;
    const target = join(targetRoot, name);
    rmSync(target, { recursive: true, force: true });
    cpSync(source, target, {
      recursive: lstatSync(source).isDirectory(),
      dereference: false,
      preserveTimestamps: true,
    });
  }
}

function isWorkspaceControlPath(path: string): boolean {
  return WORKSPACE_CONTROL_ROOTS.has(path.split("/")[0] ?? "");
}

function readGitInventory(root: string): string[] | null {
  if (!existsSync(join(root, ".git"))) return null;
  const repository = spawnSync(
    "git",
    ["-C", root, "rev-parse", "--is-inside-work-tree"],
    { encoding: "utf8" },
  );
  if (repository.status !== 0 || repository.stdout.trim() !== "true") return null;
  const result = spawnSync(
    "git",
    ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error("BTCC could not read the repository source inventory");
  }
  return inventoryWithDirectories(
    result.stdout
      .split("\0")
      .filter(Boolean)
      .map(normalizeInventoryPath)
      .filter((path) => !isWorkspaceControlPath(path))
      .filter((path) => existsSync(inventoryPath(root, path)) || isSymlink(inventoryPath(root, path))),
  );
}

function readFilesystemInventory(root: string): string[] {
  const paths: string[] = [];
  visit(root, "", paths);
  return paths.sort(compareInventoryPaths);
}

function visit(root: string, parent: string, paths: string[]): void {
  for (const name of readdirSync(parent ? join(root, parent) : root)) {
    const relativePath = parent ? `${parent}/${name}` : name;
    if (isWorkspaceControlPath(relativePath)) continue;
    const absolute = inventoryPath(root, relativePath);
    paths.push(relativePath);
    if (lstatSync(absolute).isDirectory()) visit(root, relativePath, paths);
  }
}

function inventoryWithDirectories(files: string[]): string[] {
  const paths = new Set(files);
  for (const file of files) {
    const parts = file.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      paths.add(parts.slice(0, index).join("/"));
    }
  }
  return [...paths].sort(compareInventoryPaths);
}

function compareInventoryPaths(left: string, right: string): number {
  const depth = left.split("/").length - right.split("/").length;
  return depth || left.localeCompare(right);
}

function normalizeInventoryPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("BTCC repository inventory contains an unsafe path");
  }
  return normalized;
}

function inventoryPath(root: string, relativePath: string): string {
  return join(root, ...relativePath.split("/"));
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
