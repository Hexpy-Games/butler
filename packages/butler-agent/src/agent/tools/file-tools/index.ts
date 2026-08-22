import { join } from "node:path";
import type { WorkspaceReference } from "../../session-workspaces/index.ts";
import type { ButlerToolExecutorRegistry } from "../butler-tools.ts";
import { executeReadFileTool } from "./read_file/index.ts";
import { executeWriteFileTool } from "./write_file/index.ts";
import { executeEditFileTool } from "./edit_file/index.ts";
import { executeGrepFilesTool } from "./grep_files/index.ts";
import { executeListFilesTool } from "./list_files/index.ts";

export { readFileToolDefinition, readFileToolMetadata } from "./read_file/index.ts";
export { writeFileToolDefinition, writeFileToolMetadata } from "./write_file/index.ts";
export { editFileToolDefinition, editFileToolMetadata } from "./edit_file/index.ts";
export { grepFilesToolDefinition, grepFilesToolMetadata } from "./grep_files/index.ts";
export { listFilesToolDefinition, listFilesToolMetadata } from "./list_files/index.ts";
export { resolveWorkspacePathGuard, looksSensitiveWorkspacePath } from "./shared/workspace-path-guard.ts";

export function createFileToolHandlers(input: { butlerData?: string; workspacePath?: string; workspaceReference?: WorkspaceReference; mutationScope?: readonly string[]; allowedToolsAndEffects?: readonly string[] } = {}): ButlerToolExecutorRegistry {
  const context = {
    ...input,
    protectedProjectLedgerRoots: input.butlerData
      ? [join(input.butlerData, "project-ledger", "projects")]
      : undefined,
  };
  return {
    read_file: (call) => executeReadFileTool(call, context),
    write_file: (call) => executeWriteFileTool(call, context),
    edit_file: (call) => executeEditFileTool(call, context),
    grep_files: (call) => executeGrepFilesTool(call, context),
    list_files: (call) => executeListFilesTool(call, context),
  };
}
