import { createRunCommandToolHandlers as createHandlerMap } from "./run_command/executor.ts";

export function createRunCommandToolHandlers(input: Parameters<typeof createHandlerMap>[0]) {
  return createHandlerMap(input);
}

export { runCommandTool } from "./run_command/executor.ts";
