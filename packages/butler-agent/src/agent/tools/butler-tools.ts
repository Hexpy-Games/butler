import { TodoListStore } from "../work/todo-list.ts";
import { WorkStreamStore } from "../work/work-stream.ts";
import {
  createUnavailableWorkspaceReference,
  createWorkspaceReference,
  type SessionWorkspaceBindingStore,
  type WorkspaceReference,
} from "../session-workspaces/index.ts";
import type { WebSearchProvider } from "../../integrations/search/provider.ts";
import {
  type SmartSearchPlanningInput,
  type SmartSearchPlanningResult,
} from "../../integrations/search/planning.ts";
import { readPageConfigured } from "../../integrations/search/page-reader.ts";
import { AutomationStore } from "../../operations/service/automation-store.ts";
import type { VectorEpisodeBackend } from "../cognition/memory/recall/vector.ts";
import type { BtccAgentLoopToolDefinition } from "../btcc/agent-loop/index.ts";
import type { PublicWorkObligationKind } from "./tool-support.ts";
import {
  completionObligationEvidenceReceiptsFromResult,
  hasEvidenceCapabilityReceiptField,
  readCompletionObligationEvidence,
} from "../output/completion/obligation-evidence.ts";
import {
  evidenceReceiptsFromResult,
  satisfiedCompletionObligationsFromEvidenceReceipts,
} from "../output/evidence/receipts.ts";
import { createAutomationToolHandlers } from "./automation/index.ts";
import { createDataTableToolHandlers } from "./data-table/index.ts";
import { createMcpToolHandlers } from "./mcp/index.ts";
import { createImageToolHandlers } from "./image/index.ts";
import { createMemoryToolHandlers } from "./memory/index.ts";
import { createMonitoringToolHandlers } from "./monitoring/index.ts";
import { createToolBridgeToolHandlers } from "./tool-bridge/index.ts";
import { createProjectLedgerToolHandlers } from "./project-ledger/index.ts";
import { createSkillToolHandlers } from "./skills/index.ts";
import { createWebReadHandler } from "./web-read/index.ts";
import { createWebSearchHandler } from "./web-search/index.ts";
import { createWorkTrackingToolHandlers } from "./work-tracking/index.ts";
import { workspacePagePreviewAvailabilityOverride } from "./workspace-page-preview/index.ts";
import { createWorkspaceToolHandlers } from "./workspace-tool-handlers.ts";
import { BUTLER_TOOLS } from "./registry.ts";
import type { ExternalToolCatalogInput } from "./progressive-catalog.ts";
import type {
  ButlerToolCall,
  ButlerToolDefinition,
  NativeToolAvailabilityOverrides,
} from "./types.ts";
import type {
  ImageCapabilityEvidence,
  ImageCarrierTuple,
  VerifiedImagePayloadPort,
  VisualAdmittedManifest,
} from "../image-attachment/contracts.ts";
export { BUTLER_TOOLS, CORE_BUTLER_TOOLS } from "./registry.ts";
export type {
  ButlerToolCall,
  ButlerToolEffectBoundary,
  ButlerToolDefinition,
  ToolCapabilityCategory,
  ToolCapabilityMetadata,
} from "./types.ts";
export type ButlerToolExecutor = (call: ButlerToolCall) => Promise<unknown>;
export type ButlerToolRuntimeContext = { effectOccurrenceId?: string };
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

const BUTLER_TOOL_DEFINITIONS_BY_NAME = new Map(
  BUTLER_TOOLS.map((definition) => [definition.name, definition] as const),
);
export function createButlerToolExecutorRegistry<T extends ButlerToolExecutorRegistry>(handlers: T): T {
  return handlers;
}

async function executeRegisteredButlerTool(
  registry: ButlerToolExecutorRegistry,
  call: ButlerToolCall,
  context: ButlerToolRuntimeContext,
): Promise<unknown> {
  const execute = registry[call.name];
  if (!execute) throw new Error(`Unknown Butler tool: ${call.name}`);
  return await execute(call, context);
}

export function butlerToolsForAgentLoop(): BtccAgentLoopToolDefinition[] {
  return BUTLER_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    concurrencySafe: tool.concurrencySafe,
  }));
}

export function satisfiedCompletionObligationsForToolResult(
  toolName: string,
  result: unknown,
): PublicWorkObligationKind[] {
  if (!toolResultSucceeded(result)) return [];
  if (hasEvidenceCapabilityReceiptField(result)) {
    return readCompletionObligationEvidence({
      receipts: completionObligationEvidenceReceiptsFromResult(result),
    }).satisfied;
  }
  const receiptSatisfied = satisfiedCompletionObligationsFromEvidenceReceipts(
    evidenceReceiptsFromResult(result),
  );
  return receiptSatisfied;
}

function toolResultSucceeded(result: unknown): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) return true;
  const record = result as Record<string, unknown>;
  if (hasEvidenceCapabilityReceiptField(result)) {
    return readCompletionObligationEvidence({
      receipts: completionObligationEvidenceReceiptsFromResult(result),
    }).satisfied.length > 0;
  }
  const receiptSatisfied = satisfiedCompletionObligationsFromEvidenceReceipts(
    evidenceReceiptsFromResult(result),
  );
  if (receiptSatisfied.length > 0) return true;
  if (record.ok === false) return false;
  if (record.timed_out === true) return false;
  if (typeof record.exit_code === "number" && record.exit_code !== 0) return false;
  return true;
}

export function createButlerToolExecutor(input: {
  butlerHome: string;
  butlerData: string;
  appMessageDbPath?: string;
  workspacePath?: string;
  sessionId?: string; originChatId?: string;
  projectId?: string; turnId?: string;
  imageManifests?: readonly VisualAdmittedManifest[];
  imageCarrier?: ImageCarrierTuple;
  imageCapability?: ImageCapabilityEvidence;
  verifiedImagePayloadPort?: VerifiedImagePayloadPort;
  turnContext?: string;
  searchPlannerOriginalRequest?: string;
  workerModel?: string;
  searchPlannerModel?: string;
  memoryVectorBackend?: VectorEpisodeBackend;
  memoryVectorTimeoutMs?: number;
  webSearchProvider?: WebSearchProvider;
  searchPlanner?: (input: SmartSearchPlanningInput) => Promise<SmartSearchPlanningResult>;
  pageReader?: typeof readPageConfigured;
  currentToolNames?: readonly string[] | (() => readonly string[]);
  nativeToolDefinitions?: readonly ButlerToolDefinition[];
  hiddenNativeToolNames?: readonly string[];
  nativeToolAvailabilityOverrides?: NativeToolAvailabilityOverrides;
  describedToolIds?: readonly string[] | (() => readonly string[]);
  pluginToolCatalog?: readonly ExternalToolCatalogInput[] | (() => Promise<readonly ExternalToolCatalogInput[]>);
  pluginToolDescriber?: (input: { id: string; namespace: string; name: string }) => Promise<ExternalToolCatalogInput | null | undefined>;
  activeWorkStreamBinding?: () => { contractId: string; workStreamId: string } | null;
  executionBoundary?: ButlerToolExecutionBoundary;
  workspaceReference?: WorkspaceReference;
  sessionBindingStore?: SessionWorkspaceBindingStore;
}): ContextualButlerToolExecutor {
  const workspaceReference = input.workspaceReference ?? (input.sessionId && input.sessionBindingStore
    ? createUnavailableWorkspaceReference()
    : createWorkspaceReference(input.workspacePath ?? input.butlerHome));
  const projectLedgerWorkspaceReference = input.workspaceReference || input.sessionId
    ? workspaceReference
    : undefined;
  const todoListStore = new TodoListStore(input.butlerData);
  const workStreamStore = new WorkStreamStore(input.butlerData);
  const automationStore = new AutomationStore(input.butlerData);
  const previewOverride = workspacePagePreviewAvailabilityOverride();
  const nativeToolAvailabilityOverrides = {
    ...(previewOverride ? { inspect_workspace_page: previewOverride } : {}),
    ...(input.nativeToolAvailabilityOverrides ?? {}),
  };
  const toolExecutorRef: { current?: ButlerToolExecutorRegistry } = {};
  const executeActualTool: ContextualButlerToolExecutor = async (
    call,
    context = {},
  ) => {
    if (!toolExecutorRef.current) throw new Error("Butler tool registry is not initialized");
    const definition = BUTLER_TOOL_DEFINITIONS_BY_NAME.get(call.name);
    if (!definition) throw new Error(`Unknown Butler tool: ${call.name}`);
    const execute = (prepared?: {
      args: ButlerToolCall["args"];
      rawArguments?: ButlerToolCall["rawArguments"];
    }) => executeRegisteredButlerTool(
      toolExecutorRef.current!,
      prepared
        ? {
            ...call,
            args: prepared.args,
            ...(prepared.rawArguments === undefined
              ? {}
              : { rawArguments: prepared.rawArguments }),
          }
        : call,
      context,
    );
    return input.executionBoundary
      ? input.executionBoundary({ call, context, definition, execute })
      : execute();
  };
  const dispatchTool: ButlerToolHandler = executeActualTool;
  const toolExecutors = createButlerToolExecutorRegistry({
    ...createProjectLedgerToolHandlers({
      butlerHome: input.butlerHome,
      butlerData: input.butlerData,
      appMessageDbPath: input.appMessageDbPath,
      workspacePath: input.workspacePath,
      workspaceReference: projectLedgerWorkspaceReference,
      sessionId: input.sessionId, projectId: input.projectId,
    }),
    ...createMonitoringToolHandlers({
      butlerData: input.butlerData,
      sessionId: input.sessionId,
      webSearchProvider: input.webSearchProvider,
      currentToolNames: input.currentToolNames,
      hiddenNativeToolNames: input.hiddenNativeToolNames,
      nativeToolAvailabilityOverrides,
    }),
    ...createToolBridgeToolHandlers({
      butlerData: input.butlerData,
      webSearchProvider: input.webSearchProvider,
      pluginCatalog: input.pluginToolCatalog,
      pluginToolDescriber: input.pluginToolDescriber,
      currentToolNames: input.currentToolNames,
      nativeToolDefinitions: input.nativeToolDefinitions,
      hiddenNativeToolNames: input.hiddenNativeToolNames,
      nativeToolAvailabilityOverrides,
      describedToolIds: input.describedToolIds,
      dispatchTool,
    }),
    ...createMcpToolHandlers({
      butlerData: input.butlerData,
    }),
    ...createImageToolHandlers(input),
    ...createAutomationToolHandlers({
      sessionId: input.sessionId,
      automationStore,
    }),
    ...createWorkTrackingToolHandlers({
      butlerData: input.butlerData,
      sessionId: input.sessionId,
      originChatId: input.originChatId,
      projectId: input.projectId,
      turnId: input.turnId,
      todoListStore,
      workStreamStore,
      activeWorkStreamBinding: input.activeWorkStreamBinding,
    }),
    ...createMemoryToolHandlers({
      butlerHome: input.butlerHome,
      butlerData: input.butlerData,
      appMessageDbPath: input.appMessageDbPath,
      sessionId: input.sessionId,
      projectId: input.projectId,
      memoryVectorBackend: input.memoryVectorBackend,
      memoryVectorTimeoutMs: input.memoryVectorTimeoutMs,
    }),
    ...createSkillToolHandlers({
      butlerHome: input.butlerHome,
      butlerData: input.butlerData,
      projectId: input.projectId,
    }),
    "web_search": createWebSearchHandler({
      butlerData: input.butlerData,
      turnContext: input.turnContext,
      originalRequest: input.searchPlannerOriginalRequest,
      workerModel: input.workerModel,
      plannerModel: input.searchPlannerModel,
      provider: input.webSearchProvider,
      planner: input.searchPlanner,
    }),
    "web_read": createWebReadHandler({
      butlerData: input.butlerData,
      pageReader: input.pageReader,
    }),
    ...createDataTableToolHandlers({
      butlerData: input.butlerData,
    }),
    ...createWorkspaceToolHandlers({
      butlerHome: input.butlerHome,
      butlerData: input.butlerData,
      workspacePath: input.workspacePath,
      workspaceReference,
      sessionId: input.sessionId,
      sessionBindingStore: input.sessionBindingStore,
    }),
  });
  toolExecutorRef.current = toolExecutors;
  return executeActualTool;
}
