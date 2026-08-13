import type { ButlerToolDefinition, ToolCapabilityMetadata } from "../../types.ts";

export const bindSessionGitWorktreeToolDefinition = {
  type: "function",
  name: "bind_session_git_worktree",
  description: "Create or select a safe linked Git worktree and bind it as this project session's canonical workspace. The target path is derived by Butler; no path or destructive Git operation is accepted.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      action: {
        type: "string",
        enum: ["create", "select"],
        description: "create a linked branch worktree or select an already linked branch worktree.",
      },
      branch: {
        type: "string",
        minLength: 1,
        description: "Git branch short name; refs, revisions, control characters, and leading dashes are rejected.",
      },
      start_point: {
        type: "string",
        description: "Optional Git commit/ref used only as create's branch start point.",
      },
    },
    required: ["action", "branch"],
  },
  effectBoundary: "reviewed_persistent",
  concurrencySafe: false,
  interruptBehavior: "cancel",
  transcriptVisibility: "visible",
} satisfies ButlerToolDefinition;

export const bindSessionGitWorktreeToolMetadata = {
  category: "work",
  tags: ["git", "worktree", "session", "workspace", "native"],
  safetyNotes: [
    "Only derives targets under Butler's session worktree root and uses direct Git argv.",
    "Never deletes, prunes, resets, cleans, detaches, force-checks-out, or overwrites worktree data.",
    "Public results contain a branch label and dirty state, never absolute paths or Git stderr.",
  ],
} satisfies ToolCapabilityMetadata;
