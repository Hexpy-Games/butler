import type { VectorEpisodeBackend } from "../cognition/memory/recall/vector.ts";
import type {
  ImageCapabilityEvidence,
  ImageCarrierTuple,
  VerifiedImagePayloadPort,
  VisualAdmittedManifest,
} from "../image-attachment/contracts.ts";
import type {
  SessionWorkspaceBindingStore,
  WorkspaceReference,
} from "../session-workspaces/index.ts";
import type { WebSearchProvider } from "../../integrations/search/provider.ts";
import type {
  SmartSearchPlanningInput,
  SmartSearchPlanningResult,
} from "../../integrations/search/planning.ts";
import type { readPageConfigured } from "../../integrations/search/page-reader.ts";
import type { RuntimeMemoryAttributionPort } from
  "../../operations/diagnostics/runtime-memory-attribution/index.ts";
import type { ExternalToolCatalogInput } from "./progressive-catalog.ts";
import type {
  ButlerToolCall,
  ButlerToolDefinition,
  NativeToolAvailabilityOverrides,
} from "./types.ts";

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

export type ButlerToolExecutorInput = {
  butlerHome: string;
  butlerData: string;
  appMessageDbPath?: string;
  workspacePath?: string;
  sessionId?: string;
  originChatId?: string;
  projectId?: string;
  turnId?: string;
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
  memoryAttribution?: RuntimeMemoryAttributionPort;
};
