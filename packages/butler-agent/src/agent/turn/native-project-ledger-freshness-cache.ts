import type { FunctionToolPromptOptions } from "../../integrations/providers/provider.ts";
import { stableJsonForCache } from "./native-turn-prompt.ts";

type ToolCall = Parameters<FunctionToolPromptOptions["executeTool"]>[0];

export interface ProjectLedgerFreshnessCache {
  execute: FunctionToolPromptOptions["executeTool"];
  invalidateAfterTool(call: ToolCall): void;
}

export function createProjectLedgerFreshnessCache(
  executor: FunctionToolPromptOptions["executeTool"],
): ProjectLedgerFreshnessCache {
  const cache = new Map<string, unknown>();

  return {
    execute: async (call: ToolCall): Promise<unknown> => {
      const cacheKey = projectLedgerFreshnessCacheKey(call);
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
  if (call.name === "complete_project_work") {
    cache.clear();
    return;
  }
  if (call.name === "render_project_dashboard" && call.args.write === true) {
    cache.clear();
  }
}

function projectLedgerFreshnessCacheKey(call: ToolCall): string | null {
  if (call.name === "inspect_project_status") {
    return `inspect_project_status:${stableJsonForCache({
      project_path: typeof call.args.project_path === "string" ? call.args.project_path.trim() : "",
    })}`;
  }
  if (call.name === "query_project_work") {
    return `query_project_work:${stableJsonForCache({
      project_path: typeof call.args.project_path === "string" ? call.args.project_path.trim() : "",
      kind: typeof call.args.kind === "string" ? call.args.kind.trim() : "",
    })}`;
  }
  return null;
}
