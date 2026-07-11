import { existsSync, realpathSync } from "fs";
import path, { join, resolve } from "path";

export class ActiveProjectLedgerResolutionError extends Error {
  constructor(
    readonly code: "active_project_ledger_unresolved" | "active_project_ledger_path_escape",
    readonly safeDiagnostics: { candidate_count: number; app_row_found: boolean },
  ) {
    super(code);
    this.name = "ActiveProjectLedgerResolutionError";
  }
}

export function pathIsContained(
  root: string,
  candidate: string,
  style: "native" | "posix" | "win32" = "native",
): boolean {
  const api = style === "posix" ? path.posix : style === "win32" ? path.win32 : path;
  const relative = api.relative(api.resolve(root), api.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${api.sep}`) && relative !== ".." && !api.isAbsolute(relative));
}

export function canonicalRootFromExplicit(
  projectsRoot: string,
  explicitRef: string,
): { id: string; root: string } | null {
  if (!path.isAbsolute(explicitRef)) return null;
  const direct = resolve(explicitRef);
  if (!pathIsContained(projectsRoot, direct)) return null;
  validateCanonicalContainment(projectsRoot, direct);
  const id = path.relative(projectsRoot, direct).split(path.sep)[0];
  if (!id) throw pathEscape();
  return { id: safeProjectId(id), root: join(projectsRoot, safeProjectId(id)) };
}

export function validateCanonicalContainment(projectsRoot: string, candidate: string): void {
  if (!pathIsContained(projectsRoot, candidate)) throw pathEscape();
  const realRoot = realpathWhenPresent(projectsRoot);
  const realCandidate = realpathWhenPresent(candidate);
  if (!pathIsContained(realRoot, realCandidate)) throw pathEscape();
}

export function safeProjectId(value: string): string {
  if (!isSafeProjectId(value)) {
    throw new ActiveProjectLedgerResolutionError("active_project_ledger_unresolved", {
      candidate_count: 1,
      app_row_found: false,
    });
  }
  return value;
}

export function isSafeProjectId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(value);
}

function realpathWhenPresent(value: string): string {
  const absolute = resolve(value);
  if (existsSync(absolute)) return realpathSync.native(absolute);
  const parent = path.dirname(absolute);
  if (parent === absolute) return absolute;
  return join(realpathWhenPresent(parent), path.basename(absolute));
}

function pathEscape(): ActiveProjectLedgerResolutionError {
  return new ActiveProjectLedgerResolutionError("active_project_ledger_path_escape", {
    candidate_count: 1,
    app_row_found: false,
  });
}
