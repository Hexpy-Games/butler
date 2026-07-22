import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

export function hashDirectory(root: string): string {
  const hash = createHash("sha256");
  for (const path of walkFiles(root)) {
    const relativePath = relative(root, path).split("\\").join("/");
    hash.update(relativePath).update("\0").update(readFileSync(path)).update("\0");
  }
  return hash.digest("hex");
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Fixture catalog may not contain symlinks: ${path}`);
    if (stat.isDirectory()) files.push(...walkFiles(path));
    else if (stat.isFile()) files.push(path);
  }
  return files;
}
