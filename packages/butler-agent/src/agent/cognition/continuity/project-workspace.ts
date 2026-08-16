import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Database } from "bun:sqlite";

export function resolveCanonicalProjectWorkspace(input: {
  butlerData: string;
  projectId: string;
  boundWorkspacePath?: string | null;
}): string {
  const projectId = input.projectId.trim();
  if (!projectId) throw new Error("continuity_project_binding_missing");
  const bound = input.boundWorkspacePath?.trim();
  if (bound && isAbsolute(bound)) return bound;
  const registered = readRegisteredProjectWorkspace(input.butlerData, projectId);
  if (registered) return registered;
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
  throw new Error("continuity_project_workspace_unresolved");
}

function readRegisteredProjectWorkspace(
  butlerData: string,
  projectId: string,
): string | null {
  let database: Database | undefined;
  try {
    database = new Database(
      join(butlerData, "app-server", "butler-client.sqlite"),
      { readonly: true, strict: true },
    );
    const row = database.query(
      "SELECT workspace_path FROM projects WHERE id = ? AND archived = 0 LIMIT 1",
    ).get(projectId) as { workspace_path?: unknown } | null;
    return typeof row?.workspace_path === "string" &&
        row.workspace_path.trim() && isAbsolute(row.workspace_path)
      ? row.workspace_path
      : null;
  } catch {
    return null;
  } finally {
    database?.close(false);
  }
}
