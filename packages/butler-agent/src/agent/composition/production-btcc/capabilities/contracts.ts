import type {
  OperationRequest,
  StructuralCapabilityDefinition,
} from "../../../btcc/index.ts";

export type CapabilityExecutionContext = {
  butlerData: string;
  workspacePath: string;
  observationScopeRef?: string;
  projectRef?: string;
  resolveProjectLedgerRoot?(projectRef: string): string;
  originalRequest: string;
  signal?: AbortSignal;
};

export type ProductionCapability = StructuralCapabilityDefinition & {
  execute(
    args: Record<string, unknown>,
    context: CapabilityExecutionContext,
  ): Promise<unknown>;
};

export type ProductionCapabilityOperation = OperationRequest["kind"];
