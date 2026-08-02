export const BTCC_R3_ELECTRON_SCENARIO_SCHEMA =
  "butler.btcc-r3-electron-scenario.v1" as const;
export const BTCC_R3_ELECTRON_EVIDENCE_SCHEMA =
  "butler.btcc-r3-electron-evidence.v1" as const;

export type AccessMode = "ask_first" | "full_access" | "read_only";
export type AgentOwnership = "electron" | "harness";
export type ReasoningEffort = "high" | "low" | "max" | "medium" | "none" | "xhigh";
export type ElectronSessionKind = "chat" | "project";
export type ElectronWorkStage =
  | "conception"
  | "execution"
  | "planning"
  | "reporting"
  | "review"
  | "validation";
export type TerminalState = "cancelled" | "delivered" | "failed";

export interface ElectronFixtureFile {
  path: string;
  text: string;
}

export interface ElectronExpectedFile {
  path: string;
  contains?: string[];
}

export interface ElectronWorkExpectation {
  appliedEffectCapabilitiesInclude?: string[];
  exists?: boolean;
  status?: "abandoned" | "blocked" | "completed" | "open";
  planRevisionAtLeast?: number;
  checkpointStage?: ElectronWorkStage;
  checkpointStagesInclude?: ElectronWorkStage[];
  planReviewVerdict?: "accept" | "partial" | "revise";
  resultReviewVerdict?: "accept" | "partial" | "revise";
  completionValidationVerdict?: "accept" | "partial" | "revise";
  resultToolNamesInclude?: string[];
  projectLedgerCloseout?: boolean;
  sameWorkAsStep?: string;
}

export interface ElectronScenarioStep {
  id: string;
  prompt: string;
  timeoutMs?: number;
  reloadAfter?: boolean;
  restartAfter?: boolean;
  expect?: {
    finalIncludes?: string[];
    rendererActivityStagesInclude?: ElectronWorkStage[];
    files?: ElectronExpectedFile[];
    terminalState?: TerminalState;
    work?: ElectronWorkExpectation;
  };
}

export interface ElectronScenario {
  schema: typeof BTCC_R3_ELECTRON_SCENARIO_SCHEMA;
  id: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  accessMode?: AccessMode;
  session?: {
    id?: string;
    kind?: ElectronSessionKind;
    projectDisplayName?: string;
    title?: string;
  };
  fixtures?: ElectronFixtureFile[];
  steps: ElectronScenarioStep[];
}

export interface RendererVisibleActivity {
  content: string | null;
  stage: string;
  text: string;
  title: string;
}

export interface ElectronHarnessOptions {
  repoRoot?: string;
  runRoot?: string;
  sourceData?: string;
  bundledAgentResourceDir?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  accessMode?: AccessMode;
  smoke?: boolean;
  dryRun?: boolean;
  keepLogs?: boolean;
}

export interface PreparedRun {
  accessMode: AccessMode;
  agentOwnership: AgentOwnership;
  bundledAgentResourceDir: string | null;
  dataRoot: string;
  debugPort: number;
  electronProfile: string;
  evidencePath: string;
  interruptedExecutorReplacementUsed: boolean;
  model: string;
  projectDisplayName: string | null;
  projectId: string | null;
  projectWorkspaceRoot: string;
  reasoningEffort: ReasoningEffort;
  repoRoot: string;
  runId: string;
  runRoot: string;
  serverPort: number;
  sessionId: string;
  sessionKind: ElectronSessionKind;
  sessionTitle: string;
  sourceData: string;
  workspaceRoot: string;
}

export interface AppMessageView {
  id?: string;
  role?: string;
  status?: string;
  text?: string;
  turn_id?: string;
}

export interface AppTurnView {
  id?: string;
  state?: string;
  execution_controls?: {
    model_ref?: string;
    reasoning_effort?: string;
  };
  execution_model?: {
    model_ref?: string;
    provider_id?: string;
  };
  progress?: {
    safe_progress_rows?: Array<{ safe_label?: string }>;
    summary?: string;
  };
}

export interface AppSessionView {
  active_turn?: AppTurnView | null;
  kind?: ElectronSessionKind;
  latest_turn?: AppTurnView | null;
  messages?: AppMessageView[];
  project_id?: string;
  session_id?: string;
  status?: string;
}

export interface AppSettingsView {
  access_mode?: string;
  model?: string;
  reasoning_effort?: string;
}

export interface GuidedWorkObservation {
  appliedEffectCapabilities: string[];
  workId: string;
  status: string;
  planRevision: number | null;
  checkpointStage: string | null;
  checkpointStages: string[];
  planReviewVerdict: string | null;
  resultReviewVerdict: string | null;
  completionValidationVerdict: string | null;
  resultToolNames: string[];
  projectLedgerWorkRecords: number;
  projectLedgerCompletedWorkRecords: number;
  projectLedgerCloseoutObserved: boolean;
}

export interface StepObservation {
  stepId: string;
  promptSha256: string;
  turnId: string;
  terminalState: string;
  finalText: string;
  rendererFinalText: string;
  rendererActivities: RendererVisibleActivity[];
  providerReportedModel: string | null;
  progressMessages: string[];
  work: GuidedWorkObservation | null;
  timing: {
    submittedAtMs: number;
    acknowledgedAtMs: number;
    firstRenderedActivityAtMs: number | null;
    terminalAtMs: number;
    elapsedMs: number;
  };
  expectations: {
    passed: boolean;
    failures: string[];
  };
  reload: {
    tested: boolean;
    finalMatched: boolean | null;
  };
  restart: {
    tested: boolean;
    finalMatched: boolean | null;
  };
  screenshots: string[];
}
