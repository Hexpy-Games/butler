export const DIRECT_TOOL_CHAIN_MAX_ROUNDS = 60;
export const REPEATED_TOOL_FAMILY_LIMIT = 3;

export type RepeatedToolFamilyDecision = {
  family: string;
  count: number;
  blocked: false;
} | {
  family: string;
  count: number;
  blocked: true;
};

export class RepeatedToolFamilyGuard {
  private readonly counts = new Map<string, number>();

  constructor(private readonly limit = REPEATED_TOOL_FAMILY_LIMIT) {}

  record(name: string, args: Record<string, unknown>): RepeatedToolFamilyDecision | null {
    const family = repeatedToolFamilyKey(name, args);
    if (!family) return null;
    const count = (this.counts.get(family) ?? 0) + 1;
    this.counts.set(family, count);
    if (count <= this.limit) {
      return { family, count, blocked: false };
    }
    return {
      family,
      count,
      blocked: true,
    };
  }

  resetAfterStateMutation(name: string, args: Record<string, unknown>): void {
    if (isStateMutatingToolCall(name, args)) {
      this.counts.clear();
    }
  }
}

export function directToolRoundLimit(requestedRounds: number): number {
  return Math.max(1, Math.min(requestedRounds, DIRECT_TOOL_CHAIN_MAX_ROUNDS));
}

export function repeatedToolFamilyKey(name: string, args: Record<string, unknown>): string | null {
  if (name === "inspect_project_status") return "project-ledger:status";
  if (name === "query_project_work") {
    const kind = typeof args.kind === "string" && args.kind.trim() ? args.kind.trim() : "query";
    return `project-ledger:query:${kind}`;
  }
  if (name === "render_project_dashboard") {
    const view = typeof args.view === "string" && args.view.trim() ? args.view.trim() : "dashboard";
    return `project-ledger:render:${view}`;
  }
  if (name !== "run_command") return null;
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (!command) return null;
  if (/\bproject-ledger\s+status\b/u.test(command)) return "project-ledger:status";
  if (/\bproject-ledger\s+check\b/u.test(command)) return "project-ledger:check";
  const ledgerQuery = command.match(/\bproject-ledger\s+query\b[\s\S]*?\s--kind\s+([A-Za-z0-9._-]+)/u)?.[1];
  if (ledgerQuery) return `project-ledger:query:${ledgerQuery}`;
  if (/^bun\s+test\b/u.test(command)) return "command:test";
  if (/^bun\s+run\s+typecheck\b/u.test(command)) return "command:typecheck";
  if (/^bun\s+run\s+check\b/u.test(command)) return "command:check";
  if (/^git\s+status\b/u.test(command)) return "command:git-status";
  if (/^git\s+diff\b/u.test(command)) return "command:git-diff";
  return null;
}

export function isStateMutatingToolCall(name: string, args: Record<string, unknown>): boolean {
  if (name !== "run_command") {
    return ![
      "inspect_project_status",
      "query_project_work",
      "render_project_dashboard",
      "web_search",
      "web_read",
      "read_tool_output_artifact",
      "list_todo_list",
    ].includes(name);
  }
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (!command) return false;
  if (/\b(?:apply_patch|git\s+(?:add|commit|merge|rebase|cherry-pick|rm|mv|tag)|npm\s+(?:install|update)|bun\s+(?:install|add|remove))\b/u.test(command)) {
    return true;
  }
  if (/\b(?:touch|mkdir|rm|mv|cp)\b/u.test(command)) return true;
  if (/\b(?:sed|perl)\s+-i\b/u.test(command)) return true;
  if (/(?:^|[\s;&|])(?:cat|printf|echo)\b[\s\S]*(?:>|>>|\|\s*tee\b)/u.test(command)) return true;
  if (/(?:^|[\s;&|])project-ledger\s+(?:work|task|attempt)\s+(?:create|update|complete|start|succeed|fail)\b/u.test(command)) return true;
  if (/(?:^|[\s;&|])project-ledger\s+render\b[\s\S]*\s--write\b/u.test(command)) return true;
  return false;
}
