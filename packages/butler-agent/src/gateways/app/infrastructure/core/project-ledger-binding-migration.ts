import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

interface ProjectLedgerBindingRow {
  id: string;
  display_name: string;
  workspace_path: string;
  workspace_label: string;
  safe_path_label: string;
  ledger_project_id: string | null;
}

interface InitializedLedgerCandidate {
  id: string;
  physicalRoot: string;
}

export function initializeProjectLedgerBindings(
  db: Database,
  options: { butlerData?: string },
): void {
  const rows = db.query<ProjectLedgerBindingRow, []>(`
    SELECT id, display_name, workspace_path, workspace_label, safe_path_label,
      ledger_project_id
    FROM projects
    ORDER BY id COLLATE BINARY
  `).all();
  const labelCounts = textCounts(rows.map((row) => row.safe_path_label));
  const projectIds = groupedText(rows.map((row) => row.id));
  const assignedBindings = new Set<string>();
  const assignedPhysicalRoots = new Set<string>();
  const boundProjects = new Set<string>();
  const initializedCandidates = new Map<string, InitializedLedgerCandidate[]>();
  const projectsRoot = options.butlerData?.trim()
    ? resolve(options.butlerData, "project-ledger", "projects")
    : null;

  for (const row of rows) {
    const existing = row.ledger_project_id?.trim();
    if (existing) {
      assignedBindings.add(bindingKey(existing));
      boundProjects.add(row.id);
      const physicalRoot = projectsRoot
        ? initializedPhysicalRoot(projectsRoot, existing)
        : null;
      if (physicalRoot) assignedPhysicalRoots.add(physicalRoot);
    }
    if (!existing) {
      initializedCandidates.set(
        row.id,
        initializedLegacyLedgers(row, projectsRoot),
      );
    }
  }
  const initializedCounts = exactTextCounts(
    [...initializedCandidates.values()].flat().map((candidate) =>
      candidate.physicalRoot,
    ),
  );
  const requireIdFallback = new Set<string>();
  const update = db.query(`
    UPDATE projects
    SET ledger_project_id = ?
    WHERE id = ?
      AND (ledger_project_id IS NULL OR trim(ledger_project_id) = '')
  `);
  const bind = (
    row: ProjectLedgerBindingRow,
    ledgerProjectId: string,
    physicalRoot?: string,
  ): void => {
    update.run(ledgerProjectId, row.id);
    assignedBindings.add(bindingKey(ledgerProjectId));
    if (physicalRoot) assignedPhysicalRoots.add(physicalRoot);
    boundProjects.add(row.id);
  };

  for (const row of rows) {
    if (boundProjects.has(row.id)) continue;
    const candidates = initializedCandidates.get(row.id) ?? [];
    if (candidates.length === 0) continue;
    if (candidates.length !== 1) {
      requireIdFallback.add(row.id);
      continue;
    }
    const initialized = candidates[0]!;
    const key = bindingKey(initialized.id);
    if (initializedCounts.get(initialized.physicalRoot) !== 1
      || assignedBindings.has(key)
      || assignedPhysicalRoots.has(initialized.physicalRoot)) {
      requireIdFallback.add(row.id);
      continue;
    }
    bind(row, initialized.id, initialized.physicalRoot);
  }

  rows.forEach((row, index) => {
    if (boundProjects.has(row.id)) return;
    const legacyKey = bindingKey(row.safe_path_label);
    const idsWithLegacyKey = projectIds.get(legacyKey) ?? [];
    const legacyBindingIsSafe = !requireIdFallback.has(row.id)
      && safeLedgerProjectId(row.safe_path_label)
      && labelCounts.get(legacyKey) === 1
      && idsWithLegacyKey.every((projectId) => projectId === row.id)
      && !assignedBindings.has(legacyKey)
      && ledgerRootAvailable(projectsRoot, row.safe_path_label);
    bind(
      row,
      legacyBindingIsSafe
        ? row.safe_path_label
        : uniqueLedgerProjectId(
            row.id,
            index,
            assignedBindings,
            requireIdFallback.has(row.id)
              ? new Set((initializedCandidates.get(row.id) ?? []).map(
                  (candidate) => bindingKey(candidate.id),
                ))
              : undefined,
            projectsRoot,
          ),
    );
  });
}

function initializedLegacyLedgers(
  row: ProjectLedgerBindingRow,
  projectsRoot: string | null,
): InitializedLedgerCandidate[] {
  if (!projectsRoot) return [];
  const physicalRoots = new Set<string>();
  const initialized: InitializedLedgerCandidate[] = [];
  for (const candidate of uniqueText([
    readJsonString(join(row.workspace_path, "project.json"), "id"),
    readJsonString(join(row.workspace_path, "package.json"), "name"),
    basename(resolve(row.workspace_path)),
    row.safe_path_label,
    row.workspace_label,
    row.display_name,
    row.id,
  ])) {
    const physicalRoot = initializedPhysicalRoot(projectsRoot, candidate);
    if (!physicalRoot || physicalRoots.has(physicalRoot)) continue;
    physicalRoots.add(physicalRoot);
    initialized.push({ id: candidate, physicalRoot });
  }
  return initialized;
}

function initializedPhysicalRoot(
  projectsRoot: string,
  candidate: string,
): string | null {
  if (!safeLedgerProjectId(candidate)) return null;
  const root = join(projectsRoot, candidate);
  if (!existsSync(join(root, "project.json"))
    || !existsSync(join(root, "ledger.jsonl"))) return null;
  try {
    const physicalProjectsRoot = realpathSync.native(projectsRoot);
    const physicalRoot = realpathSync.native(root);
    return pathContained(physicalProjectsRoot, physicalRoot)
      ? physicalRoot
      : null;
  } catch {
    return null;
  }
}

function pathContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === ""
    || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function textCounts(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = bindingKey(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function exactTextCounts(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function groupedText(values: string[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const value of values) {
    const key = bindingKey(value);
    grouped.set(key, [...(grouped.get(key) ?? []), value]);
  }
  return grouped;
}

function uniqueText(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  return values.flatMap((value) => {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) return [];
    seen.add(normalized);
    return [normalized];
  });
}

function uniqueLedgerProjectId(
  projectId: string,
  rowIndex: number,
  assigned: ReadonlySet<string>,
  forbidden: ReadonlySet<string> = new Set(),
  projectsRoot: string | null = null,
): string {
  const base = safeLedgerProjectId(projectId)
    ? projectId
    : `project-ledger-${rowIndex + 1}`;
  if (!assigned.has(bindingKey(base))
    && !forbidden.has(bindingKey(base))
    && ledgerRootAvailable(projectsRoot, base)) {
    return base;
  }
  for (let suffixIndex = 2; ; suffixIndex += 1) {
    const suffix = `-ledger-${suffixIndex}`;
    const candidate = `${base.slice(0, 120 - suffix.length)}${suffix}`;
    if (!assigned.has(bindingKey(candidate))
      && !forbidden.has(bindingKey(candidate))
      && ledgerRootAvailable(projectsRoot, candidate)) return candidate;
  }
}

function ledgerRootAvailable(
  projectsRoot: string | null,
  ledgerProjectId: string,
): boolean {
  return !projectsRoot || !existsSync(join(projectsRoot, ledgerProjectId));
}

function safeLedgerProjectId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(value);
}

function readJsonString(file: string, key: string): string | null {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const candidate = value[key];
    return typeof candidate === "string" && candidate.trim()
      ? candidate.trim()
      : null;
  } catch {
    return null;
  }
}

function bindingKey(value: string): string {
  return value.toLowerCase();
}
