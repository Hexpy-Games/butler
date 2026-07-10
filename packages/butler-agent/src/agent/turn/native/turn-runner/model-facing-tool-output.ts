import { realpathSync } from "node:fs";

const MODEL_ONLY_FIELDS = new Set([
  "public_work_decision",
  "public_work_decision_context",
]);

export function modelFacingToolOutput(value: unknown, workspacePath: string): unknown {
  return projectValue(value, workspaceAliases(workspacePath), 0);
}

function projectValue(value: unknown, aliases: readonly string[], depth: number): unknown {
  if (depth > 12) return "[bounded]";
  if (typeof value === "string") return relativeWorkspaceText(value, aliases);
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map((item) => projectValue(item, aliases, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !MODEL_ONLY_FIELDS.has(key))
    .map(([key, item]) => [key, projectValue(item, aliases, depth + 1)]));
}

function workspaceAliases(workspacePath: string): string[] {
  const aliases = new Set<string>();
  const configured = workspacePath.trim().replace(/\/+$/u, "");
  if (configured) aliases.add(configured);
  try {
    aliases.add(realpathSync(configured).replace(/\/+$/u, ""));
  } catch {
    // The configured path remains usable even if it disappears during teardown.
  }
  if (configured.startsWith("/var/")) aliases.add(`/private${configured}`);
  return [...aliases].filter(Boolean).sort((left, right) => right.length - left.length);
}

function relativeWorkspaceText(value: string, aliases: readonly string[]): string {
  let output = value;
  for (const alias of aliases) {
    output = output.split(`${alias}/`).join("");
    if (output === alias) output = ".";
  }
  return output;
}
