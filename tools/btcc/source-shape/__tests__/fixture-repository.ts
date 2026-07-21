import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

export type FixtureRepository = {
  root: string;
  changedPaths: string[];
  write(path: string, source: string, changed?: boolean): void;
  remove(): void;
};

export function createFixtureRepository(): FixtureRepository {
  const root = mkdtempSync(join(tmpdir(), "butler-btcc-shape-"));
  const changedPaths: string[] = [];
  return {
    root,
    changedPaths,
    write(path, source, changed = true) {
      const absolutePath = join(root, path);
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, source);
      if (changed) changedPaths.push(path);
    },
    remove() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
