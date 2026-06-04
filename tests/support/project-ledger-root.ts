import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const repoRoot = process.cwd();

function unique(values: string[]): string[] {
  return values.filter((value, index) => value.length > 0 && values.indexOf(value) === index);
}

export function butlerProjectLedgerRoot(): string {
  const candidates = unique([
    process.env.PROJECT_LEDGER_ROOT ?? "",
    process.env.BUTLER_DATA
      ? join(process.env.BUTLER_DATA, "project-ledger", "projects", "butler")
      : "",
    join(homedir(), ".butler", "project-ledger", "projects", "butler"),
  ]);

  const root = candidates.find((candidate) => existsSync(join(candidate, "project.json")));
  if (!root) {
    throw new Error(`No Butler Project Ledger root found. Checked: ${candidates.join(", ")}`);
  }
  return root;
}

export function resolveRepoOrLedgerPath(path: string): string {
  const canonicalPrefix = "project-ledger/projects/butler/";
  if (path.startsWith(canonicalPrefix)) {
    return join(butlerProjectLedgerRoot(), path.slice(canonicalPrefix.length));
  }
  return join(repoRoot, path);
}

export function readRepoOrLedgerFile(path: string): string {
  return readFileSync(resolveRepoOrLedgerPath(path), "utf8");
}

export function repoOrLedgerExists(path: string): boolean {
  return existsSync(resolveRepoOrLedgerPath(path));
}
