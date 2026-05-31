import type { ToolDefinition, StoredSessionBinding } from "../../test-support/harness/contracts.ts";
import type { GatewayDurableRole } from "../../gateways/core/contracts.ts";

export type PolicyApprovalMode = "default" | "require-approval";

export interface PolicyToolDefinition extends ToolDefinition {
  roles?: GatewayDurableRole[];
  requiresProject?: boolean;
  requiresApproval?: boolean;
}

const BLOCKED_DIRECT_TOOL_NAMES = new Set([
  "agent",
  "agent_spawn",
  "bash",
  "edit",
  "edit_file",
  "glob",
  "glob_files",
  "grep",
  "grep_files",
  "multiedit",
  "multi_edit",
  "notebookedit",
  "notebook_edit",
  "run_shell",
  "write",
  "write_file",
]);

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase();
}

export interface FilterToolsInput {
  binding: StoredSessionBinding;
  tools: PolicyToolDefinition[];
  approvalMode?: PolicyApprovalMode;
}

export class PolicyEngine {
  filterTools(input: FilterToolsInput): PolicyToolDefinition[] {
    const approvalMode = input.approvalMode ?? "default";

    return input.tools.filter((tool) => {
      if (BLOCKED_DIRECT_TOOL_NAMES.has(normalizeToolName(tool.name))) {
        return false;
      }
      if (tool.roles && !tool.roles.includes(input.binding.role)) {
        return false;
      }
      if (tool.requiresProject && !input.binding.projectId) {
        return false;
      }
      if (approvalMode === "require-approval" && tool.requiresApproval) {
        return false;
      }
      return true;
    });
  }
}
