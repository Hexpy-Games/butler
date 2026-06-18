export function parseToolArgs(call: { arguments?: unknown; input?: unknown; args?: unknown }): Record<string, unknown> {
  const raw = call.arguments ?? call.input ?? call.args ?? {};
  if (typeof raw === "string") {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  }
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

export function getWorkspaceRoot(args: Record<string, unknown>, fallback?: string): string {
  const explicit = args.workspace_root;
  if (typeof explicit === "string" && explicit.trim()) return explicit;
  if (fallback && fallback.trim()) return fallback;
  return process.cwd();
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
