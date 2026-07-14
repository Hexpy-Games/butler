import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export function resolveCanonicalProjectWorkspace(input: {
  butlerData: string;
  projectId: string;
  boundWorkspacePath?: string | null;
}): string {
  const projectId = input.projectId.trim();
  if (!projectId) throw new Error("continuity_project_binding_missing");
  const configPath = join(input.butlerData, "butler.config.json");
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as { projects?: unknown };
    const projects = Array.isArray(raw.projects) ? raw.projects : Object.values(raw.projects ?? {});
    const match = (projects as Array<{ name?: unknown; path?: unknown }>).find(
      (entry) => entry?.name === projectId && typeof entry.path === "string" && entry.path.trim(),
    );
    if (match && typeof match.path === "string" && isAbsolute(match.path)) return match.path;
  } catch {
    // The authenticated session binding is the canonical fallback snapshot.
  }
  const bound = input.boundWorkspacePath?.trim();
  if (!bound || !isAbsolute(bound)) throw new Error("continuity_project_workspace_unresolved");
  return bound;
}
