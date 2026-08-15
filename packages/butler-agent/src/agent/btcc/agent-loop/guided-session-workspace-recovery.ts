import { join } from "node:path";
import { createPlatformCommandExecutor } from "../../../runtime/command/platform-command-executor.ts";
import { SessionBindingStore } from "../../../test-support/harness/session-store.ts";
import {
  recoverSessionWorkspaceReference,
  type SessionWorkspaceBindingStore,
  type WorkspaceReference,
} from "../../session-workspaces/index.ts";

export type GuidedSessionWorkspaceBindingStore = SessionWorkspaceBindingStore;

export function createGuidedSessionWorkspaceRuntime(input: {
  butlerData: string;
  bindingStore?: GuidedSessionWorkspaceBindingStore;
}): GuidedSessionWorkspaceRuntime {
  const bindingStore = input.bindingStore ?? new SessionBindingStore(
    join(input.butlerData, "runtime", "session-store.sqlite"),
  );
  return {
    bindingStore,
    recover: (recoveryInput) => recoverGuidedSessionWorkspaceReference({
      ...recoveryInput,
      bindingStore,
    }),
  };
}

export interface GuidedSessionWorkspaceRuntime {
  bindingStore: GuidedSessionWorkspaceBindingStore;
  recover(input: {
    sessionId: string;
    projectWorkspacePath: string;
    signal?: AbortSignal;
  }): Promise<WorkspaceReference>;
}

export async function recoverGuidedSessionWorkspaceReference(input: {
  sessionId: string;
  bindingStore: SessionWorkspaceBindingStore;
  projectWorkspacePath: string;
  signal?: AbortSignal;
}): Promise<WorkspaceReference> {
  const recovered = await recoverSessionWorkspaceReference({
    sessionId: input.sessionId,
    bindingStore: input.bindingStore,
    projectWorkspacePath: input.projectWorkspacePath,
    commandExecutor: createPlatformCommandExecutor(),
    signal: input.signal,
  });
  return recovered.workspaceReference;
}
