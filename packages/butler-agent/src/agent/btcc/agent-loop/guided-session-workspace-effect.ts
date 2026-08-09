import type { EffectAdapter } from "../effects/index.ts";
import {
  bindSessionGitWorktree,
  type BindSessionGitWorktreeResult,
  type SessionWorkspaceBindingStore,
  type WorkspaceReference,
} from "../../session-workspaces/index.ts";

export type SessionWorkspaceEffectInput = {
  action: "create" | "select";
  branch: string;
  start_point?: string;
};

export function normalizeSessionWorkspaceEffectInput(
  args: Record<string, unknown>,
): SessionWorkspaceEffectInput {
  if (args.action !== "create" && args.action !== "select") {
    throw new Error("bind_session_git_worktree requires action create or select");
  }
  if (typeof args.branch !== "string" || !args.branch.trim()) {
    throw new Error("bind_session_git_worktree requires branch");
  }
  if (args.action === "select" && args.start_point !== undefined) {
    throw new Error("start_point is only valid for create");
  }
  if (args.start_point !== undefined && typeof args.start_point !== "string") {
    throw new Error("bind_session_git_worktree start_point must be a string");
  }
  return {
    action: args.action,
    branch: args.branch.trim(),
    ...(args.start_point === undefined ? {} : { start_point: args.start_point.trim() }),
  };
}

export function createGuidedSessionWorkspaceEffectAdapter(input: {
  butlerData: string;
  sessionId: string;
  sessionBindingStore: SessionWorkspaceBindingStore;
  workspaceReference: WorkspaceReference;
  target: string;
}): EffectAdapter<SessionWorkspaceEffectInput, BindSessionGitWorktreeResult> {
  return {
    capability: "bind_session_git_worktree",
    reviewedPlanBinding: "accepted_plan",
    normalizeTarget(target: string): string {
      if (target !== input.target) throw new Error("session workspace effect target changed");
      return target;
    },
    sanitizeTarget(target: string): string { return target; },
    normalizeInput(inputValue: unknown): SessionWorkspaceEffectInput {
      if (!inputValue || typeof inputValue !== "object" || Array.isArray(inputValue)) {
        throw new Error("session workspace effect input must be an object");
      }
      return normalizeSessionWorkspaceEffectInput(inputValue as Record<string, unknown>);
    },
    async dispatch(effect) {
      const result = await runSessionWorkspaceEffect(input, effect.normalizedInput, effect.signal);
      if (result.ok) return { status: "applied", result };
      return {
        status: "not_applied",
        error: {
          code: result.error.code,
          message: "The session Git worktree operation was not applied.",
          recoverable: true,
        },
      };
    },
    async reconcile(effect) {
      const result = await runSessionWorkspaceEffect(input, effect.normalizedInput, effect.signal);
      if (result.ok) return { status: "applied", result };
      return { status: "not_applied" };
    },
  };
}

async function runSessionWorkspaceEffect(
  input: {
    butlerData: string;
    sessionId: string;
    sessionBindingStore: SessionWorkspaceBindingStore;
    workspaceReference: WorkspaceReference;
  },
  effect: SessionWorkspaceEffectInput,
  signal: AbortSignal,
): Promise<BindSessionGitWorktreeResult> {
  return await bindSessionGitWorktree({
    action: effect.action,
    branch: effect.branch,
    ...(effect.start_point === undefined ? {} : { startPoint: effect.start_point }),
    sessionId: input.sessionId,
    butlerData: input.butlerData,
    bindingStore: input.sessionBindingStore,
    workspaceReference: input.workspaceReference,
    signal,
  });
}
