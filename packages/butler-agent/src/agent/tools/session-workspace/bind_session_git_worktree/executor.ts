import {
  bindSessionGitWorktree,
  type SessionWorkspaceBindingStore,
  type WorkspaceReference,
} from "../../../session-workspaces/index.ts";
import { createPlatformCommandExecutor } from "../../../../runtime/command/platform-command-executor.ts";
import type { CommandExecutor } from "../../../../runtime/command/contracts.ts";
import type { ButlerToolExecutorRegistry } from "../../butler-tools.ts";

type SessionWorkspaceToolCall = {
  args: Record<string, unknown>;
  signal?: AbortSignal;
};

export function createSessionWorkspaceToolHandlers(input: {
  butlerData: string;
  sessionId?: string;
  bindingStore?: SessionWorkspaceBindingStore;
  workspaceReference?: WorkspaceReference;
  commandExecutor?: CommandExecutor;
}): ButlerToolExecutorRegistry {
  return {
    bind_session_git_worktree: async (call: SessionWorkspaceToolCall) => {
      if (!input.sessionId || !input.bindingStore || !input.workspaceReference) {
        return unavailableResult("session_workspace_unavailable");
      }
      const action = call.args.action;
      const branch = call.args.branch;
      if (action !== "create" && action !== "select") {
        return unavailableResult("invalid_action");
      }
      if (typeof branch !== "string") {
        return unavailableResult("invalid_branch");
      }
      if (call.args.start_point !== undefined && typeof call.args.start_point !== "string") {
        return unavailableResult("invalid_start_point");
      }
      const result = await bindSessionGitWorktree({
        action,
        branch,
        ...(call.args.start_point === undefined ? {} : { startPoint: call.args.start_point }),
        sessionId: input.sessionId,
        butlerData: input.butlerData,
        bindingStore: input.bindingStore,
        workspaceReference: input.workspaceReference,
        commandExecutor: input.commandExecutor ?? createPlatformCommandExecutor(),
        signal: call.signal,
      });
      return result;
    },
  };
}

function unavailableResult(code: string): Record<string, unknown> {
  return {
    ok: false,
    error: {
      code,
      recoverable: true,
    },
  };
}
