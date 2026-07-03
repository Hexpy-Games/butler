import { PlannedTaskStore } from "../work/planned-task.ts";
import { TaskStore } from "../work/task-store.ts";
import { WorkOrchestrationStore } from "../work/work-orchestration.ts";
import { TodoListStore } from "../work/todo-list.ts";
import { WorkStreamStore } from "../work/work-stream.ts";
import type { WebSearchProvider } from "../../integrations/search/provider.ts";
import {
  type SmartSearchPlanningInput,
  type SmartSearchPlanningResult,
} from "../../integrations/search/planning.ts";
import { readPageConfigured } from "../../integrations/search/page-reader.ts";
import { AutomationStore } from "../../operations/service/automation-store.ts";
import {
  type RetrievalPlanningInput,
  type RetrievalPlanningResult,
} from "../cognition/memory/retrieval-planning.ts";
import type { VectorEpisodeBackend } from "../cognition/memory/recall/vector.ts";
import type { AgentLoopToolDefinition } from "../turn/agent-loop.ts";
import type { FunctionToolPromptOptions } from "../../integrations/providers/provider.ts";
import type { PublicWorkObligationKind } from "../turn/native/output/tool-types.ts";
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
import { createMemoryToolHandlers } from "./memory/index.ts";
import { createMonitoringToolHandlers } from "./monitoring/index.ts";
import { createToolBridgeToolHandlers } from "./tool-bridge/index.ts";
import { createOrchestrationToolHandlers } from "./orchestration/index.ts";
import { createPlannedTaskToolHandlers, dispatchBackgroundTask, type WorkerModelSelectionRule } from "./planned-task/index.ts";
import { createProjectLedgerToolHandlers } from "./project-ledger/index.ts";
import { createRunCommandToolHandlers } from "./run-command/index.ts";
import { createFileToolHandlers } from "./file-tools/index.ts";
import { createSkillToolHandlers } from "./skills/index.ts";
import { createWebReadHandler } from "./web-read/index.ts";
import { createWebSearchHandler } from "./web-search/index.ts";
import { createWorkTrackingToolHandlers } from "./work-tracking/index.ts";
import { createWorkerToolHandlers } from "./worker/index.ts";
import { BUTLER_TOOLS } from "./registry.ts";
import type { ExternalToolCatalogInput } from "./progressive-catalog.ts";
export {
  BUTLER_TOOLS,
  CORE_BUTLER_TOOLS,
} from "./registry.ts";
export type {
  ButlerToolDefinition,
  ToolCapabilityCategory,
  ToolCapabilityMetadata,
} from "./types.ts";

export type ButlerToolExecutor = FunctionToolPromptOptions["executeTool"];
export type ButlerToolCall = Parameters<ButlerToolExecutor>[0];
export type ButlerToolHandler = (call: ButlerToolCall) => Promise<unknown> | unknown;
export type ButlerToolExecutorRegistry = Record<string, ButlerToolHandler>;

export function createButlerToolExecutorRegistry<T extends ButlerToolExecutorRegistry>(handlers: T): T {
  return handlers;
}

async function executeRegisteredButlerTool(
  registry: ButlerToolExecutorRegistry,
  call: ButlerToolCall,
): Promise<unknown> {
  const execute = registry[call.name];
  if (!execute) throw new Error(`Unknown Butler tool: ${call.name}`);
  return await execute(call);
}

export function butlerToolsForAgentLoop(): AgentLoopToolDefinition[] {
  return BUTLER_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters as AgentLoopToolDefinition["inputSchema"],
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
  turnContext?: string;
  searchPlannerOriginalRequest?: string;
  workerModel?: string;
  workerModelRules?: WorkerModelSelectionRule[];
  searchPlannerModel?: string;
  memoryRetrievalPlanner?: (input: RetrievalPlanningInput) => Promise<RetrievalPlanningResult>;
  memoryVectorBackend?: VectorEpisodeBackend;
  memoryVectorTimeoutMs?: number;
  dispatchTask?: typeof dispatchBackgroundTask;
  webSearchProvider?: WebSearchProvider;
  searchPlanner?: (input: SmartSearchPlanningInput) => Promise<SmartSearchPlanningResult>;
  pageReader?: typeof readPageConfigured;
  currentToolNames?: readonly string[] | (() => readonly string[]);
  describedToolIds?: readonly string[] | (() => readonly string[]);
  pluginToolCatalog?: readonly ExternalToolCatalogInput[] | (() => Promise<readonly ExternalToolCatalogInput[]>);
  pluginToolDescriber?: (input: { id: string; namespace: string; name: string }) => Promise<ExternalToolCatalogInput | null | undefined>;
}): ButlerToolExecutor {
  const taskStore = new TaskStore(input.butlerData);
  const plannedTaskStore = new PlannedTaskStore(input.butlerData);
  const todoListStore = new TodoListStore(input.butlerData);
  const workStreamStore = new WorkStreamStore(input.butlerData);
  const automationStore = new AutomationStore(input.butlerData);
  const orchestrationStore = new WorkOrchestrationStore(input.butlerData);
  const toolExecutorRef: { current?: ButlerToolExecutorRegistry } = {};
  const dispatchTool: ButlerToolHandler = async (call) => {
    if (!toolExecutorRef.current) throw new Error("Butler tool registry is not initialized");
    return await executeRegisteredButlerTool(toolExecutorRef.current, call);
  };
  const toolExecutors = createButlerToolExecutorRegistry({
    ...createProjectLedgerToolHandlers({
      butlerHome: input.butlerHome,
      butlerData: input.butlerData,
      sessionId: input.sessionId,
      projectId: input.projectId,
    }),
    ...createMonitoringToolHandlers({
      butlerData: input.butlerData,
      sessionId: input.sessionId,
      webSearchProvider: input.webSearchProvider,
      currentToolNames: input.currentToolNames,
    }),
    ...createToolBridgeToolHandlers({
      butlerData: input.butlerData,
      webSearchProvider: input.webSearchProvider,
      pluginCatalog: input.pluginToolCatalog,
      pluginToolDescriber: input.pluginToolDescriber,
      currentToolNames: input.currentToolNames,
      describedToolIds: input.describedToolIds,
      dispatchTool,
    }),
    ...createMcpToolHandlers({
      butlerData: input.butlerData,
    }),
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
    }),
    ...createMemoryToolHandlers({
      butlerHome: input.butlerHome,
      butlerData: input.butlerData,
      appMessageDbPath: input.appMessageDbPath,
      sessionId: input.sessionId,
      projectId: input.projectId,
      turnContext: input.turnContext,
      searchPlannerOriginalRequest: input.searchPlannerOriginalRequest,
      workerModel: input.workerModel,
      searchPlannerModel: input.searchPlannerModel,
      memoryRetrievalPlanner: input.memoryRetrievalPlanner,
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
    ...createRunCommandToolHandlers({
      butlerHome: input.butlerHome,
      butlerData: input.butlerData,
      workspacePath: input.workspacePath ?? input.butlerHome,
    }),
    ...createFileToolHandlers({ workspacePath: input.workspacePath ?? input.butlerHome }),
    ...createWorkerToolHandlers({
      butlerHome: input.butlerHome,
      butlerData: input.butlerData,
      sessionId: input.sessionId,
      projectId: input.projectId,
      turnContext: input.turnContext,
      workerModel: input.workerModel,
      workerModelRules: input.workerModelRules,
      taskStore,
      plannedTaskStore,
      workStreamStore,
      orchestrationStore,
      dispatchTask: input.dispatchTask,
    }),
    ...createPlannedTaskToolHandlers({
      butlerHome: input.butlerHome,
      butlerData: input.butlerData,
      sessionId: input.sessionId,
      projectId: input.projectId,
      turnContext: input.turnContext,
      workerModel: input.workerModel,
      workerModelRules: input.workerModelRules,
      taskStore,
      plannedTaskStore,
      workStreamStore,
      orchestrationStore,
      dispatchTask: input.dispatchTask,
    }),
    ...createOrchestrationToolHandlers({
      butlerHome: input.butlerHome,
      butlerData: input.butlerData,
      sessionId: input.sessionId,
      projectId: input.projectId,
      turnContext: input.turnContext,
      workerModel: input.workerModel,
      workerModelRules: input.workerModelRules,
      taskStore,
      plannedTaskStore,
      workStreamStore,
      orchestrationStore,
      dispatchTask: input.dispatchTask,
    }),
  });
  toolExecutorRef.current = toolExecutors;
  return async (call) => executeRegisteredButlerTool(toolExecutors, call);
}
