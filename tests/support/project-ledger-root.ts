import { test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

const repoRoot = process.cwd();

function unique(values: string[]): string[] {
  return values.filter((value, index) => value.length > 0 && values.indexOf(value) === index);
}

// The canonical Butler Project Ledger (specs, plans, ADRs) lives outside the
// repository. Tests never fall back to the real ~/.butler data home: point
// PROJECT_LEDGER_ROOT (or BUTLER_DATA) at a ledger to run ledger-document tests.
function ledgerCandidates(): string[] {
  return unique([
    process.env.PROJECT_LEDGER_ROOT ?? "",
    process.env.BUTLER_DATA
      ? join(process.env.BUTLER_DATA, "project-ledger", "projects", "butler")
      : "",
  ]);
}

function findLedgerRoot(): string | undefined {
  return ledgerCandidates().find((candidate) => existsSync(join(candidate, "project.json")));
}

export const butlerProjectLedgerAvailable = findLedgerRoot() !== undefined;

/**
 * Declares a test that reads canonical Project Ledger documents. It is skipped,
 * with a one-time reason, when no ledger root is configured.
 */
export const ledgerTest = test.skipIf(!butlerProjectLedgerAvailable);

if (!butlerProjectLedgerAvailable && !process.env.BUTLER_QUIET_LEDGER_SKIP) {
  process.env.BUTLER_QUIET_LEDGER_SKIP = "1";
  console.warn(
    "Skipping Project Ledger document tests: set PROJECT_LEDGER_ROOT to the Butler "
      + "project ledger (e.g. ~/.butler/project-ledger/projects/butler) to run them.",
  );
}

export function butlerProjectLedgerRoot(): string {
  const candidates = ledgerCandidates();
  const root = findLedgerRoot();
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
