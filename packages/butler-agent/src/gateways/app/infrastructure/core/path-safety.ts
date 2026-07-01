import { homedir } from "node:os";
import { resolve, sep } from "node:path";

export function isPathInside(root: string, path: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  return (
    normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(`${normalizedRoot}${sep}`)
  );
}

export function isSensitiveProjectFolder(workspacePath: string): boolean {
  if (workspacePath === resolve("/") || workspacePath === resolve(homedir())) {
    return true;
  }
  const blockedRoots = ["/System", "/etc", "/private/etc", "/bin", "/sbin"].map(
    (root) => resolve(root),
  );
  return blockedRoots.some(
    (root) => workspacePath === root || workspacePath.startsWith(`${root}/`),
  );
}
