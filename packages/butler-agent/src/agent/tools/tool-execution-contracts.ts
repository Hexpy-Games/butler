import type { ButlerToolCall, ButlerToolDefinition } from "./types.ts";

export type ButlerToolExecutor = (call: ButlerToolCall) => Promise<unknown>;

export type ButlerToolRuntimeContext = {
  effectOccurrenceId?: string;
};

export type ContextualButlerToolExecutor = (
  call: ButlerToolCall,
  context?: ButlerToolRuntimeContext,
) => Promise<unknown>;

export type ButlerToolHandler = (
  call: ButlerToolCall,
  context?: ButlerToolRuntimeContext,
) => Promise<unknown> | unknown;

export type ButlerToolExecutorRegistry = Record<string, ButlerToolHandler>;

export type ButlerToolExecutionBoundary = (input: {
  call: ButlerToolCall;
  context: ButlerToolRuntimeContext;
  definition: ButlerToolDefinition;
  execute(prepared?: {
    args: ButlerToolCall["args"];
    rawArguments?: ButlerToolCall["rawArguments"];
  }): Promise<unknown>;
}) => Promise<unknown>;
