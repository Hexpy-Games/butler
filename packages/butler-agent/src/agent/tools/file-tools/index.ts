import { join } from "node:path";
import type { ButlerToolExecutorRegistry } from "../butler-tools.ts";
import { executeReadFileTool } from "./read_file/index.ts";
import { executeWriteFileTool } from "./write_file/index.ts";
import { executeGrepFilesTool } from "./grep_files/index.ts";

export { readFileToolDefinition, readFileToolMetadata } from "./read_file/index.ts";
export { writeFileToolDefinition, writeFileToolMetadata } from "./write_file/index.ts";
export { grepFilesToolDefinition, grepFilesToolMetadata } from "./grep_files/index.ts";
export { resolveWorkspacePathGuard, looksSensitiveWorkspacePath } from "./shared/workspace-path-guard.ts";

export function createFileToolHandlers(input: { butlerData?: string; workspacePath?: string } = {}): ButlerToolExecutorRegistry {
  const context = {
    ...input,
    protectedProjectLedgerRoots: input.butlerData
      ? [join(input.butlerData, "project-ledger", "projects")]
      : undefined,
  };
  return {
    read_file: (call) => executeReadFileTool(call, context),
    write_file: (call) => executeWriteFileTool(call, context),
    grep_files: (call) => executeGrepFilesTool(call, context),
  };
}
