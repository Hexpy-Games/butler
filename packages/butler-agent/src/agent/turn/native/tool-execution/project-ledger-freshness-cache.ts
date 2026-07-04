import type { FunctionToolPromptOptions } from "../../../../integrations/providers/provider.ts";
import { projectLedgerProjectPath } from "../../../../integrations/project-ledger/client.ts";
import { stableJsonForCache } from "../context/turn-prompt.ts";

type ToolCall = Parameters<FunctionToolPromptOptions["executeTool"]>[0];

const PROJECT_LEDGER_MUTATION_TOOLS = new Set([
  "complete_project_work",
  "project_ledger_index",
  "project_ledger_create",
  "project_ledger_update",
  "project_ledger_work_update",
  "project_ledger_work_complete",
  "project_ledger_task_update",
  "project_ledger_task_complete",
  "project_ledger_attempt_start",
  "project_ledger_attempt_succeed",
  "project_ledger_attempt_fail",
]);

export interface ProjectLedgerFreshnessCache {
  execute: FunctionToolPromptOptions["executeTool"];
  invalidateAfterTool(call: ToolCall): void;
}

export function createProjectLedgerFreshnessCache(
  executor: FunctionToolPromptOptions["executeTool"],
  input: {
    butlerHome?: string;
    butlerData?: string;
    appMessageDbPath?: string;
    projectId?: string;
    workspacePath?: string;
  } = {},
): ProjectLedgerFreshnessCache {
  const cache = new Map<string, unknown>();

  return {
    execute: async (call: ToolCall): Promise<unknown> => {
      const cacheKey = projectLedgerFreshnessCacheKey(call, input);
      if (cacheKey && cache.has(cacheKey)) return cache.get(cacheKey);
      const result = await executor(call);
      if (cacheKey) {
        cache.set(cacheKey, result);
      } else {
        invalidateProjectLedgerFreshnessAfterTool(cache, call);
      }
      return result;
    },
    invalidateAfterTool(call: ToolCall): void {
      invalidateProjectLedgerFreshnessAfterTool(cache, call);
    },
  };
}

function invalidateProjectLedgerFreshnessAfterTool(
  cache: Map<string, unknown>,
  call: ToolCall,
): void {
  if (call.name === "run_command") {
    cache.clear();
    return;
  }
  if (PROJECT_LEDGER_MUTATION_TOOLS.has(call.name)) {
    cache.clear();
    return;
  }
  if (
    (call.name === "render_project_dashboard" || call.name === "project_ledger_render") &&
    call.args.write === true
  ) {
    cache.clear();
  }
}

function projectLedgerFreshnessCacheKey(
  call: ToolCall,
  input: {
    butlerHome?: string;
    butlerData?: string;
    appMessageDbPath?: string;
    projectId?: string;
    workspacePath?: string;
  },
): string | null {
  const projectPath = resolvedProjectPathForCache(call, input);
  if (call.name === "inspect_project_status") {
    return `inspect_project_status:${stableJsonForCache({
      project_path: projectPath,
    })}`;
  }
  if (call.name === "query_project_work") {
    return `query_project_work:${stableJsonForCache({
      project_path: projectPath,
      kind: typeof call.args.kind === "string" ? call.args.kind.trim() : "",
    })}`;
  }
  return null;
}

function resolvedProjectPathForCache(
  call: ToolCall,
  input: {
    butlerHome?: string;
    butlerData?: string;
    appMessageDbPath?: string;
    projectId?: string;
    workspacePath?: string;
  },
): string {
  if (input.butlerHome && input.butlerData) {
    try {
      return projectLedgerProjectPath({
        butlerHome: input.butlerHome,
        butlerData: input.butlerData,
        appMessageDbPath: input.appMessageDbPath,
        projectId: input.projectId,
        workspacePath: input.workspacePath,
      }, call.args);
    } catch {
      // Fall through to a stable local key; cache freshness must never break tool execution.
    }
  }
  if (typeof call.args.project_path === "string" && call.args.project_path.trim()) return call.args.project_path.trim();
  if (typeof input.workspacePath === "string" && input.workspacePath.trim()) return input.workspacePath.trim();
  if (typeof input.projectId === "string" && input.projectId.trim()) return input.projectId.trim();
  return "";
}
