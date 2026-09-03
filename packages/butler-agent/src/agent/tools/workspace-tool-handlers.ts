import type { SessionWorkspaceBindingStore, WorkspaceReference } from "../session-workspaces/index.ts";
import type { ButlerToolExecutorRegistry } from "./butler-tools.ts";
import { createFileToolHandlers } from "./file-tools/index.ts";
import { createRunCommandToolHandlers } from "./run-command/index.ts";
import { createSessionWorkspaceToolHandlers } from "./session-workspace/index.ts";

export function createWorkspaceToolHandlers(input: {
  butlerHome: string;
  butlerData: string;
  workspacePath?: string;
  workspaceReference: WorkspaceReference;
  sessionId?: string;
  sessionBindingStore?: SessionWorkspaceBindingStore;
  mutationScope?: readonly string[];
  allowedToolsAndEffects?: readonly string[];
}): ButlerToolExecutorRegistry {
  const workspacePath = input.workspacePath ?? input.butlerData;
  return {
    ...createRunCommandToolHandlers({
      butlerHome: input.butlerHome,
      butlerData: input.butlerData,
      workspacePath,
      workspaceReference: input.workspaceReference,
      allowedToolsAndEffects: input.allowedToolsAndEffects,
    }),
    ...createFileToolHandlers({
      butlerHome: input.butlerHome,
      butlerData: input.butlerData,
      workspacePath,
      workspaceReference: input.workspaceReference,
      mutationScope: input.mutationScope,
      allowedToolsAndEffects: input.allowedToolsAndEffects,
    }),
    ...createSessionWorkspaceToolHandlers({
      butlerData: input.butlerData,
      sessionId: input.sessionId,
      bindingStore: input.sessionBindingStore,
      workspaceReference: input.workspaceReference,
    }),
  };
}
