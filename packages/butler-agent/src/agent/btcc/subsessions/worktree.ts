import {
  bindSessionGitWorktree,
  createWorkspaceReference,
} from "../../session-workspaces/index.ts";
import type { SubsessionDelegationDependencies } from "./contracts.ts";

/** Creates the isolated mutation worktree; read-only children never call this. */
export async function createStewardWorktree(
  input: SubsessionDelegationDependencies,
  parentWorkspacePath: string,
  branch: string,
  childSessionId: string,
): Promise<string> {
  const worktree = await bindSessionGitWorktree({
    action: "create",
    branch,
    sessionId: childSessionId,
    butlerData: input.butlerData,
    bindingStore: input.sessionBindings,
    workspaceReference: createWorkspaceReference(parentWorkspacePath),
  });
  if (!worktree.ok) {
    input.sessionBindings.deleteSession(childSessionId);
    throw new Error(`steward_worktree_unavailable:${worktree.error.code}`);
  }
  return input.sessionBindings.getBySessionId(childSessionId)?.workspacePath ??
    (() => { throw new Error("steward_isolated_workspace_missing"); })();
}
