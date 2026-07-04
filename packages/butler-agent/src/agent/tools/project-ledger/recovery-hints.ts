type NativeNextHint = {
  tool: string;
  args?: Record<string, string>;
  reason: string;
};

export function projectLedgerNativeNextHints(error: Record<string, unknown>): NativeNextHint[] {
  const code = typeof error.code === "string" ? error.code : "";
  const nativeFromCli = nativeHintsFromCliNext(error.next);
  return nativeFromCli.length > 0 ? nativeFromCli : fallbackNativeNextHints(code);
}

function nativeHintsFromCliNext(value: unknown): NativeNextHint[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => nativeHintFromCliNextItem(item))
    .filter((item): item is NativeNextHint => Boolean(item));
}

function nativeHintFromCliNextItem(value: unknown): NativeNextHint | null {
  if (typeof value === "string") return nativeHintFromCliCommand(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const command = typeof record.command === "string" ? record.command : "";
  const reason = typeof record.reason === "string" ? record.reason.trim() : "";
  return nativeHintFromCliCommand(command, reason);
}

function nativeHintFromCliCommand(command: string, reason = ""): NativeNextHint | null {
  const normalized = command.trim().replace(/\s+/gu, " ");
  if (!normalized) return null;
  if (/^(?:project-ledger|pl) index(?:\s|$)/u.test(normalized)) {
    return {
      tool: "project_ledger_index",
      args: {},
      reason: reason || "Rebuild the compact Project Ledger index for the active project.",
    };
  }

  const lifecycle = normalized.match(/^project-ledger (work|task|attempt) (create|update|complete|start|succeed|fail)(?:\s|$)(.*)$/u);
  if (!lifecycle) return null;
  const [, kind, action, rest = ""] = lifecycle;
  const toolName = nativeLifecycleToolName(kind, action);
  if (!toolName) return null;
  return {
    tool: toolName,
    args: nativeLifecycleArgs(kind, rest),
    reason: reason || `Retry with ${toolName}.`,
  };
}

function nativeLifecycleToolName(kind: string, action: string): string | null {
  if (action === "create") return "project_ledger_create";
  if (kind === "work" && action === "update") return "project_ledger_work_update";
  if (kind === "work" && action === "complete") return "project_ledger_work_complete";
  if (kind === "task" && action === "update") return "project_ledger_task_update";
  if (kind === "task" && action === "complete") return "project_ledger_task_complete";
  if (kind === "attempt" && action === "start") return "project_ledger_attempt_start";
  if (kind === "attempt" && action === "succeed") return "project_ledger_attempt_succeed";
  if (kind === "attempt" && action === "fail") return "project_ledger_attempt_fail";
  return null;
}

function nativeLifecycleArgs(kind: string, commandRest: string): Record<string, string> {
  const args: Record<string, string> = {};
  if (kind) args.kind = kind;
  const id = cliFlagValue(commandRest, "id");
  const status = cliFlagValue(commandRest, "status");
  const work = cliFlagValue(commandRest, "work");
  const task = cliFlagValue(commandRest, "task");
  if (id) args.id = id;
  if (status) args.status = status;
  if (work) args.work_id = work;
  if (task) args.task_id = task;
  return args;
}

function cliFlagValue(commandRest: string, flag: string): string | null {
  const match = commandRest.match(new RegExp(`(?:^| )--${flag} ([^ ]+)`, "u"));
  return match?.[1] ?? null;
}

function fallbackNativeNextHints(code: string): NativeNextHint[] {
  if (code === "record_not_found") {
    return [{ tool: "project_ledger_list", args: { kind: "all" }, reason: "List records, then retry with the exact id and kind." }];
  }
  if (code === "ambiguous_record" || code === "invalid_state" || code === "invalid_transition") {
    return [{ tool: "project_ledger_show", args: {}, reason: "Inspect the record and choose a valid kind-specific lifecycle action." }];
  }
  if (code === "completion_gate_failed") {
    return [{ tool: "project_ledger_work_complete", args: {}, reason: "Add missing completion evidence fields and retry work completion." }];
  }
  if (code === "project_ledger_check_failed") {
    return [{ tool: "project_ledger_check", args: {}, reason: "Review data.issues, repair source records, and rerun validation." }];
  }
  if (code === "invalid_input" || code === "invalid_arguments") {
    return [{ tool: "project_ledger_show", args: {}, reason: "Correct required Project Ledger arguments or metadata fields before retrying." }];
  }
  return [];
}
