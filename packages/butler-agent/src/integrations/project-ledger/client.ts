import { spawnSync } from "child_process";
import { randomUUID } from "crypto";
import { existsSync, readFileSync } from "fs";
import { basename, isAbsolute, join, relative, resolve } from "path";
import { Database } from "bun:sqlite";
import { butlerAgentResourcesPath } from "../../runtime/paths.ts";

export function projectLedgerPath(input: { butlerHome: string }): string {
  const packagedPath = join(input.butlerHome, "packages", "project-ledger", "bin", "project-ledger");
  if (existsSync(packagedPath)) return packagedPath;
  return butlerAgentResourcesPath(input.butlerHome, "skills", "project-ledger", "bin", "project-ledger");
}

export function projectLedgerProjectPath(
  input: {
    butlerHome: string;
    butlerData?: string;
    workspacePath?: string;
    projectId?: string;
    appMessageDbPath?: string;
  },
  args: Record<string, unknown>,
): string {
  const explicitRef = stringArg(args, "project_ref") || stringArg(args, "project_path");
  const candidates = explicitRef
    ? projectLedgerReferenceCandidates(input, explicitRef)
    : defaultProjectLedgerReferenceCandidates(input);
  for (const candidate of candidates) {
    const resolved = canonicalProjectLedgerProjectPath(input.butlerData, candidate);
    if (resolved) return resolved;
  }
  if (!explicitRef && isProjectScopedLedgerInput(input)) {
    throw new Error("project_ledger_project_resolution_failed: active project session has no resolvable Project Ledger reference");
  }
  return candidates[0] ?? input.butlerHome;
}

export function runProjectLedgerTool(
  input: { butlerHome: string; butlerData?: string },
  args: string[],
): Record<string, unknown> {
  const result = spawnSync(process.execPath, [projectLedgerPath(input), ...args, "--json"], {
    cwd: input.butlerHome,
    encoding: "utf8",
    env: {
      ...process.env,
      BUTLER_HOME: input.butlerHome,
      ...(input.butlerData ? { BUTLER_DATA: input.butlerData } : {}),
    },
    timeout: 10_000,
  });
  if (result.stdout.trim()) {
    try {
      return JSON.parse(result.stdout) as Record<string, unknown>;
    } catch {
      return {
        ok: false,
        error: {
          code: "project_ledger_invalid_json",
          message: "Project Ledger returned invalid JSON",
        },
      };
    }
  }
  return {
    ok: false,
    error: {
      code: result.error ? "project_ledger_spawn_failed" : "project_ledger_failed",
      message: result.error?.message ?? (result.stderr.trim() || `Project Ledger exited with ${result.status ?? 1}`),
    },
  };
}

export function projectLedgerRenderedViewEvidence(input: {
  projectPath: string;
  result: Record<string, unknown>;
  view: string;
  write: boolean;
}): Record<string, unknown> {
  if (!input.write || input.result.ok === false) return {};
  const data = input.result.data && typeof input.result.data === "object" && !Array.isArray(input.result.data)
    ? input.result.data as Record<string, unknown>
    : {};
  if (data.written !== true || typeof data.path !== "string" || !data.path.trim()) return {};
  const relativePath = data.path.trim();
  const artifactPath = projectLedgerArtifactPath(input.projectPath, relativePath);
  return {
    durable_artifact_created: true,
    artifact_kind: "markdown_file",
    artifact_label: relativePath,
    artifact_path: artifactPath,
    evidence_receipts: [
      {
        schema: "butler.evidence-receipt.v1",
        id: `receipt-render_project_dashboard-${randomUUID()}`,
        producer: { kind: "tool", name: "render_project_dashboard" },
        receiptType: "artifact",
        verified: true,
        covers: ["project_ledger_view", "durable_artifact"],
        summary: "Project Ledger generated view was written as a durable markdown artifact.",
        references: [{ kind: "project_document", ref: relativePath, label: basename(relativePath) }],
        artifacts: [
          {
            label: relativePath,
            path: artifactPath,
            mediaType: "text/markdown",
            role: "project_ledger_view",
          },
        ],
        satisfies: ["durable_artifact"],
      },
    ],
    verified_output_files: [
      {
        path: relativePath,
        artifact_kind: "markdown_file",
      },
    ],
  };
}

function projectLedgerArtifactPath(projectPath: string, relativePath: string): string {
  const normalizedRelativePath = relativePath.split("\\").join("/");
  if (normalizedRelativePath === "project-ledger" || normalizedRelativePath.startsWith("project-ledger/")) {
    return resolve(projectPath, "..", "..", "..", normalizedRelativePath);
  }
  return resolve(projectPath, relativePath);
}

function canonicalProjectLedgerProjectPath(butlerData: string | undefined, projectPath: string): string | null {
  if (!butlerData) return null;
  const direct = resolve(projectPath);
  const projectsRoot = join(resolve(butlerData), "project-ledger", "projects");

  if (isPathInside(projectsRoot, direct)) {
    const [id] = relative(projectsRoot, direct).split("\\").join("/").split("/");
    return id ? join(projectsRoot, id) : projectsRoot;
  }

  const [id] = projectIdCandidates(projectPath);
  return id ? join(projectsRoot, safeProjectSegment(id)) : null;
}

function defaultProjectLedgerReferenceCandidates(input: {
  butlerHome: string;
  appMessageDbPath?: string;
  projectId?: string;
  workspacePath?: string;
}): string[] {
  const appCandidates = appProjectReferenceCandidates(input, input.projectId);
  const projectIdCandidates = input.projectId && (!input.appMessageDbPath || appCandidates.length > 0)
    ? [input.projectId]
    : [];
  return uniqueNonEmptyText([
    ...appCandidates,
    ...(input.workspacePath ? workspaceProjectReferenceCandidates(input.workspacePath) : []),
    ...projectIdCandidates,
    ...(isProjectScopedLedgerInput(input) ? [] : [input.butlerHome]),
  ]);
}

function projectLedgerReferenceCandidates(
  input: {
    appMessageDbPath?: string;
    projectId?: string;
    workspacePath?: string;
  },
  ref: string,
): string[] {
  return uniqueNonEmptyText([
    ...appProjectReferenceCandidates(input, ref),
    ref,
  ]);
}

function appProjectReferenceCandidates(
  input: { appMessageDbPath?: string; projectId?: string; workspacePath?: string },
  ref: string | undefined,
): string[] {
  const dbPath = input.appMessageDbPath?.trim();
  const trimmedRef = ref?.trim();
  if (!dbPath || !existsSync(dbPath) || !trimmedRef) return [];
  let db: Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db.query<Record<string, string | null>, [string, string, string, string, string]>(`
      SELECT id, display_name, workspace_path, workspace_label, safe_path_label
      FROM projects
      WHERE archived = 0
        AND (
          id = ?
          OR display_name = ?
          OR workspace_path = ?
          OR workspace_label = ?
          OR safe_path_label = ?
        )
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(trimmedRef, trimmedRef, trimmedRef, trimmedRef, trimmedRef);
    if (!row) return [];
    return [
      row.workspace_path,
      ...(row.workspace_path ? workspaceProjectReferenceCandidates(row.workspace_path) : []),
      row.safe_path_label,
      row.workspace_label,
      row.display_name,
      row.id,
    ].filter((value): value is string => Boolean(value));
  } catch {
    return [];
  } finally {
    db?.close(false);
  }
}

function workspaceProjectReferenceCandidates(workspacePath: string): string[] {
  const resolved = resolve(workspacePath);
  return uniqueNonEmptyText([
    readJsonProjectId(join(resolved, "project.json")),
    readPackageName(join(resolved, "package.json")),
    basename(resolved),
    resolved,
  ]);
}

function stringArg(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === "string" && args[key].trim() ? args[key].trim() : "";
}

function uniqueNonEmptyText(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function isProjectScopedLedgerInput(input: {
  butlerHome: string;
  projectId?: string;
  workspacePath?: string;
}): boolean {
  if (input.projectId?.trim()) return true;
  const workspacePath = input.workspacePath?.trim();
  if (!workspacePath) return false;
  return resolve(workspacePath) !== resolve(input.butlerHome);
}

function isPathInside(root: string, path: string): boolean {
  const rel = relative(root, path).split("\\").join("/");
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
}

function projectIdCandidates(projectPath: string): string[] {
  const resolved = resolve(projectPath);
  const ids = [
    readJsonProjectId(join(resolved, "project.json")),
    readPackageName(join(resolved, "package.json")),
    basename(resolved),
  ].filter((value): value is string => Boolean(value));
  return [...new Set(ids)];
}


function readJsonProjectId(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return typeof data.id === "string" && data.id.trim() ? data.id.trim() : null;
  } catch {
    return null;
  }
}

function readPackageName(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return typeof data.name === "string" && data.name.trim() ? data.name.trim() : null;
  } catch {
    return null;
  }
}

function safeProjectSegment(value: string): string {
  const safe = value
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return safe ? safe.slice(0, 96) : "project";
}
