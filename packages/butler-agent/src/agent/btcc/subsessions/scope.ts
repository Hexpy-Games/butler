/**
 * The SS-02 Steward effect surface is intentionally closed. New capabilities
 * must be admitted by a later Task with an explicit boundary and evidence.
 */
export const SUBSESSION_ALLOWED_TOOLS_AND_EFFECTS = [
  "edit_file:workspace",
  "write_file:workspace",
] as const;

const allowedEffects = new Set<string>(SUBSESSION_ALLOWED_TOOLS_AND_EFFECTS);

export function normalizeSubsessionAllowedToolsAndEffects(
  values: readonly string[],
): string[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
    throw new Error("subsession_effect_not_allowed");
  }
  const normalized = [...new Set(values.map((value) => value.trim()))]
    .filter(Boolean)
    .sort();
  if (!normalized.length) throw new Error("delegation_allowed_effects_required");
  if (normalized.some((value) => !allowedEffects.has(value))) {
    throw new Error("subsession_effect_not_allowed");
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
  return normalizeSubsessionAllowedToolsAndEffects(values)
    .map((value) => value.slice(0, value.indexOf(":")));
}

function normalizeScopePath(value: string): string | null {
  const raw = value.trim().replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/{2,}/gu, "/");
  const directory = raw.endsWith("/");
  const normalized = raw.replace(/\/+$/u, "");
  const segments = normalized.split("/");
  if (!normalized || normalized === "." || normalized.startsWith("/") || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return null;
  }
  return directory ? `${normalized}/` : normalized;
}
