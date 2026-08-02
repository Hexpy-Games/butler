import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type {
  BenchmarkTarget,
  BtccRevision,
} from "./contracts.ts";

const UI_DIST_PATH = join(
  "packages",
  "butler-app",
  "client",
  "ui",
  "dist",
);
const BUILD_ID_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export type BenchmarkTargetBeforeBuild =
  Omit<BenchmarkTarget, "buildId"> & { buildId?: string };

export type TargetCommandRunner = (
  executable: string,
  args: readonly string[],
  cwd: string,
) => string;

export function buildBenchmarkTargets(
  targets: Record<BtccRevision, BenchmarkTargetBeforeBuild>,
  runCommand: TargetCommandRunner = runTargetCommand,
): Record<BtccRevision, BenchmarkTarget> {
  return {
    r2: buildBenchmarkTarget(targets.r2, runCommand),
    r3: buildBenchmarkTarget(targets.r3, runCommand),
  };
}

export function verifyBenchmarkTargets(
  targets: Record<BtccRevision, BenchmarkTarget>,
  runCommand: TargetCommandRunner = runTargetCommand,
): void {
  for (const target of [targets.r2, targets.r3]) {
    verifyCheckout(target, runCommand);
    if (!BUILD_ID_PATTERN.test(target.buildId)) {
      throw new Error(
        `Benchmark ${target.revision} buildId must be sha256:<digest>`,
      );
    }
    const actualBuildId = uiDistBuildId(target.worktreePath);
    if (actualBuildId !== target.buildId) {
      throw new Error(
        `Benchmark ${target.revision} UI build is ${actualBuildId}, expected ${target.buildId}`,
      );
    }
  }
}

export function uiDistBuildId(worktreePath: string): string {
  const distRoot = resolve(worktreePath, UI_DIST_PATH);
  if (!existsSync(distRoot) || !statSync(distRoot).isDirectory()) {
    throw new Error(`Benchmark UI dist is missing: ${distRoot}`);
  }
  const files = distFiles(distRoot);
  if (files.length === 0) {
    throw new Error(`Benchmark UI dist has no files: ${distRoot}`);
  }
  const hash = createHash("sha256");
  for (const path of files) {
    const name = relative(distRoot, path).split(sep).join("/");
    const bytes = readFileSync(path);
    hash.update(`${Buffer.byteLength(name, "utf8")}:${name}:${bytes.byteLength}:`);
    hash.update(bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

function buildBenchmarkTarget(
  target: BenchmarkTargetBeforeBuild,
  runCommand: TargetCommandRunner,
): BenchmarkTarget {
  verifyCheckout(target, runCommand);
  try {
    runCommand(
      process.env.BUTLER_BUN?.trim() || process.execPath,
      ["run", "app:ui:build"],
      target.worktreePath,
    );
  } catch (error) {
    throw new Error(`Benchmark ${target.revision} UI build failed`, {
      cause: error,
    });
  }
  verifyCheckout(target, runCommand);
  return {
    ...target,
    buildId: uiDistBuildId(target.worktreePath),
  };
}

function verifyCheckout(
  target: Pick<BenchmarkTarget, "commit" | "revision" | "worktreePath">,
  runCommand: TargetCommandRunner,
): void {
  const head = runCommand(
    "git",
    ["rev-parse", "HEAD"],
    target.worktreePath,
  ).trim();
  if (head !== target.commit) {
    throw new Error(
      `Benchmark ${target.revision} checkout is ${head}, expected ${target.commit}`,
    );
  }
  const status = runCommand(
    "git",
    ["status", "--short"],
    target.worktreePath,
  ).trim();
  if (status) {
    throw new Error(`Benchmark ${target.revision} checkout is not clean`);
  }
}

function distFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`Benchmark UI dist contains an unsupported entry: ${path}`);
    }
  };
  visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

function runTargetCommand(
  executable: string,
  args: readonly string[],
  cwd: string,
): string {
  return execFileSync(executable, [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}
