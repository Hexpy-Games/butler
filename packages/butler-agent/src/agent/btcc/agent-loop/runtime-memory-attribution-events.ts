import type { BtccAgentLoopEvent } from "./contracts.ts";
import type {
  RuntimeMemoryAttributionOperation,
  RuntimeMemoryAttributionPort,
} from "../../../operations/diagnostics/runtime-memory-attribution/index.ts";

export function recordRuntimeMemoryEvent(
  attribution: RuntimeMemoryAttributionPort | undefined,
  event: BtccAgentLoopEvent,
): void {
  if (!attribution) return;
  switch (event.type) {
    case "model_call":
      attribution.checkpoint({ event: "model_call_start", operation: "provider", iteration: event.iteration });
      return;
    case "model_response":
      attribution.checkpoint({ event: "model_call_end", operation: "provider", iteration: event.iteration });
      return;
    case "model_failure":
      attribution.checkpoint({ event: "model_call_failure", operation: "provider", iteration: event.iteration });
      return;
    case "tool_call":
      attribution.checkpoint({
        event: "tool_call_start",
        operation: runtimeMemoryToolOperation(event.toolCall?.name),
        iteration: event.iteration,
      });
      return;
    case "tool_result":
      attribution.checkpoint({
        event: event.toolResult?.ok ? "tool_call_end" : "tool_call_failure",
        operation: runtimeMemoryToolOperation(event.toolResult?.name),
        iteration: event.iteration,
      });
      return;
    case "execution_window_boundary":
      attribution.checkpoint({
        event: "execution_window_boundary",
        operation: "window",
        iteration: event.iteration,
        windowIndex: event.windowIndex,
      });
      return;
  }
}

function runtimeMemoryToolOperation(name: string | undefined): RuntimeMemoryAttributionOperation {
  if (name && PROJECT_LEDGER_TOOL_NAMES.has(name)) return "project_ledger";
  switch (name) {
    case "run_command":
      return "command";
    case "web_read":
    case "web_search":
      return "web";
    case "read_file":
    case "write_file":
    case "edit_file":
    case "list_files":
      return "filesystem";
    case "recall_memory":
    case "get_memory_health":
      return "memory";
    case "create_work":
    case "create_task":
    case "update_work":
    case "update_task":
      return "work_tracking";
    default:
      return "other_tool";
  }
}

const PROJECT_LEDGER_TOOL_NAMES = new Set([
  "get_work_dashboard",
  "inspect_project_status",
  "query_project_work",
  "render_project_dashboard",
  "complete_project_work",
  "project_ledger_index",
  "project_ledger_status",
  "project_ledger_list",
  "project_ledger_show",
  "project_ledger_create",
  "project_ledger_update",
  "project_ledger_work_update",
  "project_ledger_work_complete",
  "project_ledger_task_update",
  "project_ledger_task_complete",
  "project_ledger_attempt_start",
  "project_ledger_attempt_succeed",
  "project_ledger_attempt_fail",
  "project_ledger_render",
  "project_ledger_check",
]);
