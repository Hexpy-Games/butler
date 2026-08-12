import { lstatSync } from "node:fs";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";

const ALLOWED_SYSTEM_SYMLINKS = new Set(["/var", "/tmp"]);

export function hasButlerRuntimeSymlinkComponent(path: string): boolean {
  const resolved = resolve(path);
  const parsed = parse(resolved);
  let current = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink() && !ALLOWED_SYSTEM_SYMLINKS.has(current)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/** Validates the existing prefix of a directory path while permitting a
 * completely absent tail that will be created later. */
export function hasUnsafeButlerRuntimeDirectoryComponent(path: string): boolean {
  const resolved = resolve(path);
  const parsed = parse(resolved);
  let current = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        if (ALLOWED_SYSTEM_SYMLINKS.has(current)) continue;
        return true;
      }
      if (!stat.isDirectory()) return true;
    } catch (error) {
      if (error && typeof error === "object" &&
          (error as { code?: unknown }).code === "ENOENT") return false;
      return true;
    }
  }
  return false;
}

export function isStrictlyInsideButlerRuntime(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel) && !rel.includes("\0");
}
