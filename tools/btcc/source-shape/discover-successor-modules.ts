import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import {
  SOURCE_BASELINE_COMMIT,
  SUCCESSOR_DOMAIN_PATHS,
  SUCCESSOR_TEST_PATHS,
  type DiscoveredSuccessorSources,
  type MaterializedDomain,
} from "./contracts.ts";

const TYPESCRIPT_EXTENSIONS = [".cts", ".mts", ".ts", ".tsx"];

function isTypeScriptSource(path: string): boolean {
  return TYPESCRIPT_EXTENSIONS.some((extension) => path.endsWith(extension));
}

function containsPath(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === ""
    || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..");
}

function readNullSeparatedGitPaths(
  repositoryRoot: string,
  args: string[],
): string[] {
  const output = execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return output.split("\0").filter(Boolean);
}

function changedSuccessorPaths(repositoryRoot: string): string[] {
  const roots = [...SUCCESSOR_DOMAIN_PATHS, ...SUCCESSOR_TEST_PATHS];
  return [...new Set([
    ...readNullSeparatedGitPaths(repositoryRoot, [
      "diff",
      "--name-only",
      "--diff-filter=ACMRD",
      "-z",
      SOURCE_BASELINE_COMMIT,
      "--",
      ...roots,
    ]),
    ...readNullSeparatedGitPaths(repositoryRoot, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ...roots,
    ]),
  ])].sort();
}

function changedProtectedSourcePaths(repositoryRoot: string): string[] {
  return readNullSeparatedGitPaths(repositoryRoot, [
    "diff",
    "--name-only",
    "--no-renames",
    "--diff-filter=DMT",
    "-z",
    SOURCE_BASELINE_COMMIT,
    "--",
    "packages/butler-agent/src",
  ]).sort();
}

export function discoverSuccessorModulesFromPaths(
  repositoryRoot: string,
  changedPaths: readonly string[],
): DiscoveredSuccessorSources {
  const domains: MaterializedDomain[] = [];
  const filePaths = new Set<string>();
  const successorRoots = [...SUCCESSOR_DOMAIN_PATHS, ...SUCCESSOR_TEST_PATHS]
    .map((path) => resolve(repositoryRoot, path));

  for (const relativePath of SUCCESSOR_DOMAIN_PATHS) {
    const path = resolve(repositoryRoot, relativePath);
    if (!existsSync(path)) continue;

    domains.push({
      name: basename(path),
      path,
      indexPath: join(path, "index.ts"),
    });
  }

  const absoluteChanges = changedPaths
    .map((path) => resolve(repositoryRoot, path))
    .filter((path) => successorRoots.some((root) => containsPath(root, path)));
  const changedDomainPaths = domains
    .filter((domain) => absoluteChanges.some((path) => containsPath(domain.path, path)))
    .map((domain) => domain.path);

  const changedFilePaths = absoluteChanges
    .filter((path) => existsSync(path) && isTypeScriptSource(path));
  for (const path of absoluteChanges) {
    if (existsSync(path) && isTypeScriptSource(path)) filePaths.add(path);
  }
  for (const domain of domains) {
    if (changedDomainPaths.includes(domain.path) && existsSync(domain.indexPath)) {
      filePaths.add(domain.indexPath);
    }
  }

  return {
    domains: domains.sort((left, right) => left.path.localeCompare(right.path)),
    changedDomainPaths,
    changedFilePaths: changedFilePaths.sort(),
    filePaths: [...filePaths].sort(),
    protectedSourceChanges: [],
  };
}

export function discoverChangedSuccessorModules(
  repositoryRoot: string,
): DiscoveredSuccessorSources {
  const discovered = discoverSuccessorModulesFromPaths(
    repositoryRoot,
    changedSuccessorPaths(repositoryRoot),
  );
  return {
    ...discovered,
    protectedSourceChanges: changedProtectedSourcePaths(repositoryRoot),
  };
}
