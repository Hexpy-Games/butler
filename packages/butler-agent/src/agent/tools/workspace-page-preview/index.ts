import type { ButlerToolExecutorRegistry } from "../butler-tools.ts";
import {
  createInspectWorkspacePageHandler,
} from "./inspect_workspace_page/executor.ts";
import type { WorkspaceReference } from "../../session-workspaces/index.ts";

export {
  inspectWorkspacePageToolDefinition,
  inspectWorkspacePageToolMetadata,
} from "./inspect_workspace_page/definition.ts";
export { workspacePagePreviewAvailabilityOverride } from
  "./inspect_workspace_page/executor.ts";

export function createWorkspacePagePreviewToolHandlers(input: {
  butlerData: string;
  workspacePath: string;
  workspaceReference?: WorkspaceReference;
}): ButlerToolExecutorRegistry {
  return {
    inspect_workspace_page: createInspectWorkspacePageHandler(input),
  };
}
