export interface ParsedToolArgsOk { ok: true; args: Record<string, unknown>; }
export interface ParsedToolArgsError { ok: false; error: "invalid_arguments_json" | "invalid_arguments_shape"; detail: string; }
export type ParsedToolArgs = ParsedToolArgsOk | ParsedToolArgsError;

export function tryParseToolArgs(call: { arguments?: unknown; input?: unknown; args?: unknown }): ParsedToolArgs {
  const raw = call.arguments ?? call.input ?? call.args ?? {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { ok: true, args: parsed as Record<string, unknown> };
      }
      return { ok: false, error: "invalid_arguments_shape", detail: "Tool arguments JSON must decode to an object." };
    } catch (error) {
      return { ok: false, error: "invalid_arguments_json", detail: error instanceof Error ? error.message : String(error) };
    }
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return { ok: true, args: raw as Record<string, unknown> };
  }
  return { ok: false, error: "invalid_arguments_shape", detail: "Tool arguments must be an object or JSON object string." };
}

export function parseToolArgs(call: { arguments?: unknown; input?: unknown; args?: unknown }): Record<string, unknown> {
  const parsed = tryParseToolArgs(call);
  if (!parsed.ok) throw new Error(`${parsed.error}: ${parsed.detail}`);
  return parsed.args;
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
