/** The mutation Steward surface admits file effects plus bounded workspace commands. */
export const SUBSESSION_ALLOWED_TOOLS_AND_EFFECTS = [
  "edit_file:workspace",
  "run_command:workspace",
  "write_file:workspace",
] as const;

/** The read-only Steward surface is the complete effect-free native set. */
export const SUBSESSION_READ_ONLY_TOOLS_AND_EFFECTS = [
  "grep_files:workspace",
  "list_files:workspace",
  "read_file:workspace",
  "web_read:network",
  "web_search:network",
] as const;

const allowedMutationEffects = new Set<string>(SUBSESSION_ALLOWED_TOOLS_AND_EFFECTS);
const allowedReadOnlyEffects = new Set<string>(SUBSESSION_READ_ONLY_TOOLS_AND_EFFECTS);
const fileMutationEffects = new Set<string>([
  "edit_file:workspace",
  "write_file:workspace",
]);

export function normalizeSubsessionAllowedToolsAndEffects(
  values: readonly string[],
  mode: "read_only" | "mutation",
): string[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
    throw new Error("subsession_effect_not_allowed");
  }
  const normalized = [...new Set(values.map((value) => value.trim()))]
    .filter(Boolean)
    .sort();
  if (!normalized.length) throw new Error("delegation_allowed_effects_required");
  const allowed = mode === "read_only" ? allowedReadOnlyEffects : allowedMutationEffects;
  if (normalized.some((value) => !allowed.has(value))) {
    throw new Error("subsession_effect_not_allowed");
  }
  if (mode === "read_only" && normalized.length !== allowedReadOnlyEffects.size) {
    throw new Error("subsession_read_only_surface_incomplete");
  }
  return normalized;
}

export function normalizeSubsessionMutationScope(
  values: readonly string[],
): string[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
    throw new Error("subsession_mutation_scope_invalid");
  }
  if (!values.length) throw new Error("delegation_mutation_scope_required");
  const normalized = [...new Set(values.map(normalizeScopePath))];
  if (normalized.some((value) => value === null)) {
    throw new Error("subsession_mutation_scope_invalid");
  }
  const paths = normalized.filter((value): value is string => value !== null).sort();
  if (paths.some((value) => ["*", "?", "[", "]"].some((character) => value.includes(character)))) {
    throw new Error("subsession_mutation_scope_wildcard_not_allowed");
  }
  return paths;
}

export function subsessionToolNames(
  values: readonly string[],
): string[] {
  return [...new Set(values.map((value) => value.slice(0, value.indexOf(":"))))]
    .filter(Boolean)
    .sort();
}

function normalizeScopePath(value: string): string | null {
  const supplied = value.trim().replaceAll("\\", "/");
  if (supplied === "." || supplied === "./") return ".";
  const raw = supplied.replace(/^\.\//u, "").replace(/\/{2,}/gu, "/");
  const terminalSubtree = raw.endsWith("/**");
  const directory = terminalSubtree || raw.endsWith("/");
  const normalized = (terminalSubtree ? raw.slice(0, -3) : raw).replace(/\/+$/u, "");
  const segments = normalized.split("/");
  if (!normalized || normalized === "." || normalized.startsWith("/") || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return null;
  }
  return directory ? `${normalized}/` : normalized;
}

export function subsessionFileMutationScopeRequired(
  allowedToolsAndEffects: readonly string[],
): boolean {
  return allowedToolsAndEffects.some((value) => fileMutationEffects.has(value));
}

export function normalizeSubsessionMutationScopeForEffects(
  values: readonly string[],
  allowedToolsAndEffects: readonly string[],
): string[] {
  return subsessionFileMutationScopeRequired(allowedToolsAndEffects)
    ? normalizeSubsessionMutationScope(values)
    : [];
}
