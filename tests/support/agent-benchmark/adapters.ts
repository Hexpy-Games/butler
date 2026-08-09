import type { AgentAdapter } from "./contracts.ts";
import { createProcessExecutor, type CommandExecutor } from "./command.ts";
import {
  createButlerAdapter,
  createElectronButlerRunner,
  type ButlerBenchmarkRunner,
} from "./butler-adapter.ts";
import { ExternalCliAdapter } from "./external-adapter.ts";

export type { ButlerBenchmarkRunner } from "./butler-adapter.ts";
export { createButlerAdapter, createElectronButlerRunner } from "./butler-adapter.ts";
export { ExternalCliAdapter } from "./external-adapter.ts";

export interface AgentAdapterSet {
  butler: AgentAdapter;
  hermes: AgentAdapter;
  opencode: AgentAdapter;
}

export interface DefaultAdapterInput {
  sourceRoot: string;
  commandExecutor: CommandExecutor;
  butlerRunner: ButlerBenchmarkRunner;
}

/** The only production composition point for the three product adapters. */
export function createAgentAdapters(input: DefaultAdapterInput): AgentAdapterSet {
  return {
    butler: createButlerAdapter(input.butlerRunner, input.sourceRoot),
    hermes: new ExternalCliAdapter("hermes", input.commandExecutor),
    opencode: new ExternalCliAdapter("opencode", input.commandExecutor),
  };
}

export function createProductionAgentAdapters(sourceRoot: string): AgentAdapterSet {
  return createAgentAdapters({
    sourceRoot,
    commandExecutor: createProcessExecutor(),
    butlerRunner: createElectronButlerRunner(),
  });
}
