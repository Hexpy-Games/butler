import type { AgentAdapter } from "./contracts.ts";
import { createProcessExecutor, type CommandExecutor } from "./command.ts";
import {
  createButlerAdapter,
  createElectronButlerRunner,
  type ButlerBenchmarkRunner,
} from "./butler-adapter.ts";
import { ExternalCliAdapter } from "./external-adapter.ts";
import type { PreparedButlerResourceReference } from "./prepared-butler-resource.ts";

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

export interface ProductionAgentAdapterOptions {
  preparedButlerResource?: PreparedButlerResourceReference;
  rendererStartSmoke?: boolean;
}

export function createProductionAgentAdapters(
  sourceRoot: string,
  options: ProductionAgentAdapterOptions = {},
): AgentAdapterSet {
  return createAgentAdapters({
    sourceRoot,
    commandExecutor: createProcessExecutor(),
    butlerRunner: createElectronButlerRunner(
      options.preparedButlerResource,
      { rendererStartSmoke: options.rendererStartSmoke === true },
    ),
  });
}
