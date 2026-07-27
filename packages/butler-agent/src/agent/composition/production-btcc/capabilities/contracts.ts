import type {
  OperationRequest,
  StructuralCapabilityDefinition,
} from "../../../btcc/index.ts";

export type CapabilityExecutionContext = {
  butlerData: string;
  workspacePath: string;
  observationScopeRef?: string;
  externalEffect?: {
    effectIntentRef: { id: string; sha256: string };
    occurrenceKey: string;
    targetScopeRef: string;
    requestId: string;
  };
  projectRef?: string;
  resolveProjectLedgerRoot?(projectRef: string): string;
  originalRequest: string;
  operationKind: OperationRequest["kind"];
  accessMode: "full_access" | "ask_first" | "read_only";
  commandFilesystemBoundary?:
    | { kind: "isolated_workspace"; deniedReadWriteRoots: string[] }
    | { kind: "read_only_observation" };
  signal?: AbortSignal;
};

export type ProductionCapability = StructuralCapabilityDefinition & {
  execute(
    args: Record<string, unknown>,
    context: CapabilityExecutionContext,
  ): Promise<unknown>;
};

export type ProductionCapabilityOperation = OperationRequest["kind"];
