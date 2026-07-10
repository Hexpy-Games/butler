export const DIRECT_TOOL_CHAIN_MAX_ROUNDS = 60;

export type ToolStagnationDecision = {
  family: string;
  count: number;
  stagnant: boolean;
};

interface ObservedToolState {
  resultFingerprint: string;
  stateRevision: string;
  count: number;
}

export class ToolStagnationObserver {
  private readonly observed = new Map<string, ObservedToolState>();

  observe(input: {
    name: string;
    args: Record<string, unknown>;
    resultFingerprint: string;
    stateRevision: string;
    mutated: boolean;
  }): ToolStagnationDecision | null {
    if (input.mutated) {
      this.observed.clear();
      return null;
    }
    const family = repeatedToolFamilyKey(input.name, input.args);
    if (!family) return null;
    const previous = this.observed.get(family);
    const stagnant = Boolean(
      previous &&
      previous.resultFingerprint === input.resultFingerprint &&
      previous.stateRevision === input.stateRevision,
    );
    const count = stagnant ? (previous?.count ?? 1) + 1 : 1;
    this.observed.set(family, {
      resultFingerprint: input.resultFingerprint,
      stateRevision: input.stateRevision,
      count,
    });
    return {
      family,
      count,
      stagnant,
    };
  }
}

export function directToolRoundLimit(requestedRounds: number): number {
  return Math.max(1, Math.min(requestedRounds, DIRECT_TOOL_CHAIN_MAX_ROUNDS));
}

export function repeatedToolFamilyKey(name: string, args: Record<string, unknown>): string | null {
  if (name === "grep_files") {
    const pattern = typeof args.pattern === "string" ? args.pattern.trim() : "";
    return pattern ? `workspace-grep:${pattern}` : null;
  }
  if (name === "tool_search") return discoveryToolFamilyKey("tool-search", args);
  if (name === "list_tool_capabilities") return discoveryToolFamilyKey("tool-capabilities", args);
  if (name === "inspect_project_status" || name === "project_ledger_status") return "project-ledger:status";
  if (name === "project_ledger_check") return "project-ledger:check";
  if (name === "query_project_work" || name === "project_ledger_list") {
    const kind = typeof args.kind === "string" && args.kind.trim() ? args.kind.trim() : "query";
    return `project-ledger:query:${kind}`;
  }
  if (name === "project_ledger_show") {
    const id = typeof args.id === "string" && args.id.trim() ? args.id.trim() : "unknown";
    return `project-ledger:show:${id}`;
  }
  if (name === "render_project_dashboard" || name === "project_ledger_render") {
    const view = typeof args.view === "string" && args.view.trim() ? args.view.trim() : "dashboard";
    return `project-ledger:render:${view}`;
  }
  const lifecycle = projectLedgerLifecycleFamilyKey(name, args);
  if (lifecycle) return lifecycle;
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

function discoveryToolFamilyKey(prefix: string, args: Record<string, unknown>): string {
  const category = normalizedArg(args.category) ?? "any";
  const provider = normalizedArg(args.provider) ?? "any";
  const capability = normalizedArg(args.capability) ?? "any";
  const query = normalizedArg(args.query) ?? "any";
  return `${prefix}:${provider}:${category}:${capability}:${query}`;
}

function normalizedArg(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;
}

function projectLedgerLifecycleFamilyKey(name: string, args: Record<string, unknown>): string | null {
  const id = typeof args.id === "string" && args.id.trim() ? args.id.trim() : "unknown";
  const kind = typeof args.kind === "string" && args.kind.trim() ? args.kind.trim() : "record";
  const taskId = typeof args.task_id === "string" && args.task_id.trim()
    ? args.task_id.trim()
    : typeof args.task === "string" && args.task.trim()
    ? args.task.trim()
    : "unknown";
  if (name === "project_ledger_create") return `project-ledger:lifecycle:create:${kind}:${id}`;
  if (name === "project_ledger_update") return `project-ledger:lifecycle:update:${kind}:${id}`;
  if (name === "project_ledger_work_update") return `project-ledger:lifecycle:work:update:${id}`;
  if (name === "project_ledger_work_complete") return `project-ledger:lifecycle:work:complete:${id}`;
  if (name === "project_ledger_task_update") return `project-ledger:lifecycle:task:update:${id}`;
  if (name === "project_ledger_task_complete") return `project-ledger:lifecycle:task:complete:${id}`;
  if (name === "project_ledger_attempt_start") return `project-ledger:lifecycle:attempt:start:${taskId}`;
  if (name === "project_ledger_attempt_succeed") return `project-ledger:lifecycle:attempt:succeed:${id}`;
  if (name === "project_ledger_attempt_fail") return `project-ledger:lifecycle:attempt:fail:${id}`;
  if (name === "project_ledger_index") return "project-ledger:index";
  return null;
}

export function isStateMutatingToolCall(name: string, args: Record<string, unknown>): boolean {
  if (name !== "run_command") {
    if (name === "render_project_dashboard" || name === "project_ledger_render") {
      return args.write === true;
    }
    return ![
      "inspect_project_status",
      "query_project_work",
      "project_ledger_status",
      "project_ledger_list",
      "project_ledger_show",
      "project_ledger_check",
      "web_search",
      "web_read",
      "read_tool_evidence_artifact",
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
