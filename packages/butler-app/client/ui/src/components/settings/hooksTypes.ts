export const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SubagentStop"] as const;
export type HookEvent = typeof HOOK_EVENTS[number];
export interface HookDefinition {
  id: string;
  name: string | null;
  event: HookEvent;
  match: { tools: string[] };
  type: "command";
  command: string | null;
  args: string[] | null;
  env: Record<string, string>;
  timeout_ms: number;
  async: boolean;
  failClosed: boolean;
  enabled: boolean;
  schema_version: number;
}
export interface HookSettings {
  revision: number;
  config: { version: number; hooks: HookDefinition[] };
  error: string | null;
}
export interface HookRun {
  time: string;
  hook_id: string;
  event: HookEvent;
  session_id: string | null;
  outcome: string;
  reason: string | null;
  exit_code: number | null;
  duration_ms: number;
  stdout: string;
  stderr: string;
}
export function emptyHook(): HookDefinition {
  return { id: crypto.randomUUID(), name: "", event: "PreToolUse", match: { tools: [] }, type: "command",
    command: "", args: null, env: {}, timeout_ms: 30_000, async: false, failClosed: false, enabled: true, schema_version: 1 };
}
export function blockingEvent(event: HookEvent): boolean {
  return ["UserPromptSubmit", "PreToolUse", "Stop", "SubagentStop"].includes(event);
}
