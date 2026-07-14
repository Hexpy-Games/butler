import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export function resolveCanonicalProjectWorkspace(input: {
  butlerData: string;
  projectId: string;
  boundWorkspacePath?: string | null;
}): string {
  const projectId = input.projectId.trim();
  if (!projectId) throw new Error("continuity_project_binding_missing");
  const appRegistryPath = join(
    input.butlerData,
    "app-server",
    "butler-client.sqlite",
  );
  if (existsSync(appRegistryPath)) {
    let db: Database | null = null;
    try {
      db = new Database(appRegistryPath, { readonly: true });
      const row = db
        .query<{ workspace_path: string }, [string]>(
          `
        SELECT workspace_path
        FROM projects
        WHERE id = ? AND archived = 0
        LIMIT 1
      `,
        )
        .get(projectId);
      if (row) {
        const workspace = row.workspace_path.trim();
        if (!workspace || !isAbsolute(workspace)) {
          throw new Error("continuity_project_registry_path_invalid");
        }
        return workspace;
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "continuity_project_registry_path_invalid"
      ) {
        throw error;
      }
      throw new Error("continuity_project_registry_unreadable", {
        cause: error,
      });
    } finally {
      db?.close();
    }
  }
  const configPath = join(input.butlerData, "butler.config.json");
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as {
      projects?: unknown;
    };
    const projects = Array.isArray(raw.projects)
      ? raw.projects
      : Object.values(raw.projects ?? {});
    const match = (projects as Array<{ name?: unknown; path?: unknown }>).find(
      (entry) =>
        entry?.name === projectId &&
        typeof entry.path === "string" &&
        entry.path.trim(),
    );
    if (match && typeof match.path === "string" && isAbsolute(match.path))
      return match.path;
  } catch {
    // The authenticated session binding is the canonical fallback snapshot.
  }
  const bound = input.boundWorkspacePath?.trim();
  if (!bound || !isAbsolute(bound))
    throw new Error("continuity_project_workspace_unresolved");
  return bound;
}
