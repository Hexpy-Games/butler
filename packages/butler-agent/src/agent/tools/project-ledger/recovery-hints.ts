type NativeNextHint = {
  tool: string;
  args: Record<string, string>;
  reason: string;
};

type CallContext = {
  toolName: string;
  args: Record<string, unknown>;
};

export function projectLedgerNativeNextHints(
  error: Record<string, unknown>,
  context?: CallContext,
): NativeNextHint[] {
  const code = typeof error.code === "string" ? error.code : "";
  const projectRef = stringArg(context?.args.project_ref);
  const scope: Record<string, string> = projectRef ? { project_ref: projectRef } : {};
  // CLI lifecycle suggestions may contain placeholders or omit required evidence.
  // Keep those in error.next as guidance, not as executable native calls.
  if (Array.isArray(error.next)) {
    for (const item of error.next) {
      const command = typeof item === "string" ? item : item?.command;
      if (typeof command === "string" && /^(?:project-ledger|pl) index(?:\s|$)/u.test(command.trim())) {
        return [{
          tool: "project_ledger_index",
          args: scope,
          reason: "Rebuild the compact Project Ledger index for this project.",
        }];
      }
    }
  }
  if (code === "record_not_found" || code === "ambiguous_record") {
    return [{
      tool: "project_ledger_list",
      args: { ...scope, kind: "all" },
      reason: "List records, then retry with the exact id and kind.",
    }];
  }
  if (code === "project_ledger_check_failed") {
    return [{
      tool: "project_ledger_check",
      args: scope,
      reason: "Review data.issues, repair source records, and rerun validation.",
    }];
  }
  const id = stringArg(context?.args.id);
  if (!id || context?.toolName === "project_ledger_create") return [];
  if (["invalid_state", "invalid_transition", "completion_gate_failed", "invalid_input", "invalid_arguments"].includes(code)) {
    const kind = stringArg(context?.args.kind) ||
      context?.toolName.match(/^project_ledger_(work|task|attempt)_/u)?.[1];
    return [{
      tool: "project_ledger_show",
      args: { ...scope, id, ...(kind ? { kind } : {}) },
      reason: "Inspect the record, correct the reported arguments or missing evidence, and retry the original lifecycle action.",
    }];
  }
  return [];
}

function stringArg(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
