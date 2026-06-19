import type { ButlerToolExecutorRegistry } from "../butler-tools.ts";
import { readFileToolDefinition, readFileToolMetadata, executeReadFileTool } from "./read_file/index.ts";
import { writeFileToolDefinition, writeFileToolMetadata, executeWriteFileTool } from "./write_file/index.ts";

export { readFileToolDefinition, readFileToolMetadata } from "./read_file/index.ts";
export { writeFileToolDefinition, writeFileToolMetadata } from "./write_file/index.ts";
export { resolveWorkspacePathGuard, looksSensitiveWorkspacePath } from "./shared/workspace-path-guard.ts";

export function createFileToolHandlers(input: { workspacePath?: string } = {}): ButlerToolExecutorRegistry {
  return {
    read_file: (call) => executeReadFileTool(call, input),
    write_file: (call) => executeWriteFileTool(call, input),
  };
}
