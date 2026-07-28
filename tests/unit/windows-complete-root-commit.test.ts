import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWindowsCompleteRootCommit } from
  "../../packages/butler-agent/src/foundation/complete-root-commit/adapters/windows.ts";

const filesystemOperations = { exists: existsSync, move: renameSync };

test("Windows complete-root commit swaps candidate and baseline", () => {
  withRoots(({ stage, target }) => {
    const commit = createWindowsCompleteRootCommit(filesystemOperations);
    commit.exchange(stage, target);
    expect(content(target)).toBe("candidate");
    expect(content(stage)).toBe("baseline");
  });
});

test("Windows complete-root commit resumes after target displacement", () => {
  withRoots(({ stage, target }) => {
    const displaced = `${stage}.btcc-displaced`;
    renameSync(target, displaced);

    const commit = createWindowsCompleteRootCommit(filesystemOperations);
    expect(commit.reconcileExchange(stage, target)).toBe(true);
    expect(content(target)).toBe("candidate");
    expect(content(stage)).toBe("baseline");
    expect(existsSync(displaced)).toBe(false);
  });
});

test("Windows complete-root commit resumes after candidate installation", () => {
  withRoots(({ stage, target }) => {
    const displaced = `${stage}.btcc-displaced`;
    renameSync(target, displaced);
    renameSync(stage, target);

    const commit = createWindowsCompleteRootCommit(filesystemOperations);
    expect(commit.reconcileExchange(stage, target)).toBe(true);
    expect(content(target)).toBe("candidate");
    expect(content(stage)).toBe("baseline");
    expect(existsSync(displaced)).toBe(false);
  });
});

test("Windows complete-root commit restores the target when installation fails", () => {
  withRoots(({ stage, target }) => {
    const commit = createWindowsCompleteRootCommit({
      exists: existsSync,
      move(source, destination) {
        if (source === stage) throw new Error("injected candidate move failure");
        renameSync(source, destination);
      },
    });

    expect(() => commit.exchange(stage, target)).toThrow(
      "injected candidate move failure",
    );
    expect(content(target)).toBe("baseline");
    expect(content(stage)).toBe("candidate");
  });
});

function withRoots(
  run: (paths: { root: string; stage: string; target: string }) => void,
): void {
  const root = mkdtempSync(join(tmpdir(), "butler-windows-root-commit-"));
  const stage = join(root, "stage");
  const target = join(root, "target");
  try {
    createRoot(stage, "candidate");
    createRoot(target, "baseline");
    run({ root, stage, target });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function createRoot(path: string, value: string): void {
  mkdirSync(path);
  writeFileSync(join(path, "value.txt"), value);
}

function content(path: string): string {
  return readFileSync(join(path, "value.txt"), "utf8");
}
