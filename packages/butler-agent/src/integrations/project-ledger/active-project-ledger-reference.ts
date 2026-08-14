import { existsSync, readFileSync, statSync } from "fs";
import path, { basename, join, resolve } from "path";
import {
  ActiveProjectLedgerResolutionError,
  canonicalRootFromExplicit,
  isSafeProjectId,
  safeProjectId,
  validateCanonicalContainment,
} from "./active-project-ledger-paths.ts";

export { ActiveProjectLedgerResolutionError, pathIsContained } from "./active-project-ledger-paths.ts";

export const ACTIVE_PROJECT_LEDGER_REFERENCE_SCHEMA = "butler.active-project-ledger-reference.v1" as const;
const ACTIVE_REFERENCE_CACHE_LIMIT = 32;

export interface ActiveProjectLedgerReference {
  schema_version: typeof ACTIVE_PROJECT_LEDGER_REFERENCE_SCHEMA;
  app_project_id: string;
  workspace_path: string;
  workspace_label?: string;
  display_name?: string;
  ledger_project_id: string;
  ledger_root: string;
  source: "workspace_metadata" | "explicit_canonical_ref";
  resolved_at: string;
  initialized: boolean;
  degradation_code?: "app_project_db_missing" | "app_project_row_missing";
  ambiguity_count?: number;
  /** Internal cache validator; excluded from public projection. */
  initialization_generation: string;
}

export interface PublicActiveProjectLedgerReference {
  schema_version: typeof ACTIVE_PROJECT_LEDGER_REFERENCE_SCHEMA;
  app_project_id: string;
  workspace_label?: string;
  display_name?: string;
  ledger_project_id: string;
  source: ActiveProjectLedgerReference["source"];
  initialized: boolean;
  degradation_code?: ActiveProjectLedgerReference["degradation_code"];
}

export class ActiveProjectLedgerResolver {
  private readonly cache = new Map<string, ActiveProjectLedgerReference>();

  resolve(input: {
    butlerData: string;
    appProjectId?: string;
    workspacePath?: string;
    explicitRef?: string;
    fallbackWorkspacePath?: string;
    now?: Date;
  }): ActiveProjectLedgerReference {
    const projectsRoot = resolve(input.butlerData, "project-ledger", "projects");
    const cacheKey = this.cacheKey(input, projectsRoot);
    const cached = this.cache.get(cacheKey);
    if (cached && cached.initialization_generation === ledgerInitializationGeneration(cached.ledger_root)) return cached;
    if (cached) this.cache.delete(cacheKey);
    const explicitCanonical = input.explicitRef?.trim()
      ? canonicalRootFromExplicit(projectsRoot, input.explicitRef.trim())
      : null;
    if (explicitCanonical) {
      const reference = buildReference({
        appProjectId: input.appProjectId ?? explicitCanonical.id,
        workspacePath: explicitCanonical.root,
        ledgerProjectId: explicitCanonical.id,
        ledgerRoot: explicitCanonical.root,
        source: "explicit_canonical_ref",
        now: input.now,
      });
      this.store(cacheKey, reference);
      return reference;
    }
    const explicitWorkspacePath = input.explicitRef && path.isAbsolute(input.explicitRef)
      ? input.explicitRef
      : undefined;
    // A live session workspace is authoritative for workspace-scoped operations,
    // while the App row still supplies the canonical Ledger identity below.
    const workspacePath = explicitWorkspacePath ?? input.workspacePath ?? input.fallbackWorkspacePath;
    const candidateIds = orderedCandidateIds({
      workspacePath,
      explicitRef: input.explicitRef,
      appProjectId: input.appProjectId,
    });
    const roots = candidateIds.map((id) => ({ id, root: join(projectsRoot, safeProjectId(id)) }));
    for (const candidate of roots) validateCanonicalContainment(projectsRoot, candidate.root);
    const initialized = roots.filter((candidate) =>
      projectLedgerRootInitialized(candidate.root),
    );
    const selected = initialized[0] ?? roots[0];
    const referenceWorkspacePath = workspacePath ?? (
      input.explicitRef && !path.isAbsolute(input.explicitRef) ? selected?.root : undefined
    );
    if (!selected || !referenceWorkspacePath) {
      throw new ActiveProjectLedgerResolutionError("active_project_ledger_unresolved", {
        candidate_count: candidateIds.length,
        app_row_found: false,
      });
    }
    const reference = buildReference({
      appProjectId: input.appProjectId ?? selected.id,
      workspacePath: referenceWorkspacePath,
      ledgerProjectId: selected.id,
      ledgerRoot: selected.root,
      source: "workspace_metadata",
      now: input.now,
      ambiguityCount: initialized.length > 1 ? initialized.length : undefined,
    });
    this.store(cacheKey, reference);
    return reference;
  }

  clear(): void {
    this.cache.clear();
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  private cacheKey(
    input: { butlerData: string; appProjectId?: string; workspacePath?: string; explicitRef?: string },
    projectsRoot: string,
  ): string {
    return JSON.stringify({
      butlerData: resolve(input.butlerData),
      appProjectId: input.appProjectId ?? "",
      workspacePath: input.workspacePath ?? "",
      explicitRef: input.explicitRef ?? "",
      projectsGeneration: fileGeneration(projectsRoot),
    });
  }

  private store(key: string, reference: ActiveProjectLedgerReference): void {
    this.cache.set(key, reference);
    while (this.cache.size > ACTIVE_REFERENCE_CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (typeof oldest !== "string") break;
      this.cache.delete(oldest);
    }
  }
}

export function publicActiveProjectLedgerReference(
  reference: ActiveProjectLedgerReference,
): PublicActiveProjectLedgerReference {
  return {
    schema_version: reference.schema_version,
    app_project_id: reference.app_project_id,
    ...(reference.workspace_label ? { workspace_label: reference.workspace_label } : {}),
    ...(reference.display_name ? { display_name: reference.display_name } : {}),
    ledger_project_id: reference.ledger_project_id,
    source: reference.source,
    initialized: reference.initialized,
    ...(reference.degradation_code ? { degradation_code: reference.degradation_code } : {}),
  };
}

function orderedCandidateIds(input: {
  workspacePath?: string;
  explicitRef?: string;
  appProjectId?: string;
}): string[] {
  const workspaceIds = input.workspacePath ? workspaceProjectIds(input.workspacePath) : [];
  const values = [
    ...workspaceIds,
    input.explicitRef && !path.isAbsolute(input.explicitRef)
      ? input.explicitRef
      : null,
    input.appProjectId,
  ];
  const seen = new Set<string>();
  return values.flatMap((value) => {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized) || !isSafeProjectId(normalized)) return [];
    seen.add(normalized);
    return [normalized];
  });
}

function workspaceProjectIds(workspacePath: string): string[] {
  const workspace = resolve(workspacePath);
  return [
    readJsonString(join(workspace, "project.json"), "id"),
    readJsonString(join(workspace, "package.json"), "name"),
    basename(workspace),
  ].filter((value): value is string => Boolean(value));
}

function buildReference(input: {
  appProjectId: string;
  workspacePath: string;
  workspaceLabel?: string;
  displayName?: string;
  ledgerProjectId: string;
  ledgerRoot: string;
  source: ActiveProjectLedgerReference["source"];
  now?: Date;
  degradationCode?: ActiveProjectLedgerReference["degradation_code"];
  ambiguityCount?: number;
}): ActiveProjectLedgerReference {
  return {
    schema_version: ACTIVE_PROJECT_LEDGER_REFERENCE_SCHEMA,
    app_project_id: input.appProjectId,
    workspace_path: resolve(input.workspacePath),
    ...(input.workspaceLabel ? { workspace_label: input.workspaceLabel } : {}),
    ...(input.displayName ? { display_name: input.displayName } : {}),
    ledger_project_id: input.ledgerProjectId,
    ledger_root: resolve(input.ledgerRoot),
    source: input.source,
    resolved_at: (input.now ?? new Date()).toISOString(),
    initialized: projectLedgerRootInitialized(input.ledgerRoot),
    initialization_generation: ledgerInitializationGeneration(input.ledgerRoot),
    ...(input.degradationCode ? { degradation_code: input.degradationCode } : {}),
    ...(input.ambiguityCount ? { ambiguity_count: input.ambiguityCount } : {}),
  };
}

export function projectLedgerRootInitialized(root: string): boolean {
  return existsSync(join(root, "project.json")) && existsSync(join(root, "ledger.jsonl"));
}

function ledgerInitializationGeneration(root: string): string {
  return `${fileGeneration(join(root, "project.json"))}|${fileGeneration(join(root, "ledger.jsonl"))}`;
}

function readJsonString(file: string, key: string): string | null {
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    return typeof data[key] === "string" && data[key].trim() ? data[key].trim() : null;
  } catch {
    return null;
  }
}

function fileGeneration(file: string | undefined): string {
  if (!file || !existsSync(file)) return "missing";
  const stat = statSync(file);
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}
