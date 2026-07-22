import type { ReasoningEffort } from "../../../packages/butler-agent/src/agent/btcc/index.ts";

export type ModelCell = {
  id: string;
  provider: string;
  model: string;
  reasoningEffort: ReasoningEffort;
};

export type LiveInbound =
  | { kind: "inline_utf8"; text: string; contentSha256: string }
  | {
      kind: "canonical_local_ref";
      messageRef: string;
      contentSha256: string;
      reviewedEquivalentSha256: string;
    }
  | {
      kind: "authorized_continuation_wake";
      outboxRef: string;
      authorizationRef: string;
      readinessReceiptRef: string;
      sourceTerminalReceiptAssertionId: string;
    };

export type LiveTurnStep = {
  stepId: string;
  inbound: LiveInbound;
  appActions: Array<{
    kind: "ui_stop_active_turn";
    afterTraceAssertionId: string;
    expectedStopReceiptAssertionId: string;
  }>;
  expectedGoalFields: Array<{ fieldId: string; semanticAssertionId: string }>;
  expectedRoute: "direct" | "assisted" | "managed";
  expectedLedgerScope: "none" | "project" | "session";
  requiredTrace: Array<{ ordinal: number; state: string; acceptedEvent: string }>;
  allowedAlternativeTraceRefs: string[];
  forbiddenStates: string[];
  expectedEffects: Array<{ effectId: string; operation: string }>;
  expectedArtifacts: Array<{ artifactId: string; targetRef: string }>;
  checkpointAssertions: Array<{ kind: string; checkpointId: string }>;
  expectedFinalDisposition: "completed" | "deferred" | "cancelled";
  relation:
    | { kind: "initial" }
    | {
        kind: "fresh_continuation";
        priorStepId: string;
        requireDistinctTurnId: true;
        requiredPriorDisposition: "deferred";
      };
};

export type LiveSetupStep = { kind: string; [key: string]: unknown };

export type LiveScenario = {
  schema: "butler.btcc.live-scenario.v1";
  scenarioId: string;
  fixtureId: string;
  setupSteps: LiveSetupStep[];
  turns: LiveTurnStep[];
  cleanupPolicyId: string;
};

export type LiveManifest = {
  schema: "butler.btcc.live-scenarios.v1";
  governingSpecId: string;
  liveRequiredScenarioIds: string[];
  priorFailureFixture: {
    reviewedEquivalent: { text: string; contentSha256: string };
  };
  scenarios: LiveScenario[];
  expectedCounts: {
    scenarioCount: number;
    turnStepCount: number;
    modelCellCount: number;
    expectedLiveMatrixPairCount: number;
  };
};

export type FixtureCatalogEntry = {
  ref: string;
  kind: "directory" | "text";
  path: string;
  sha256: string;
};

export type FixtureCatalog = {
  schema: "butler.btcc.live-diagnostic-fixture-catalog.v1";
  entries: FixtureCatalogEntry[];
};

export type ScenarioFixture = {
  workspacePath: string;
  butlerData: string;
  projectRef?: string;
  sessionId: string;
  sourceRefs: string[];
  context: {
    profile: string[];
    recentFeedback: string[];
    mandatoryHotCache: string[];
    optionalHotCache: string[];
  };
  canonicalMessages: Map<string, string>;
};

export type TraceObservation = {
  ordinal: number;
  turnRevision: number;
  state: string;
  acceptedEvent: string | null;
  source: "persisted_transition_reconstruction";
};

export type OperationObservation = {
  requestId: string;
  kind: string;
  capabilityRef: string;
  outcome: string;
  observationRef?: { id: string; sha256: string };
};

export type TurnObservation = {
  stepId: string;
  turnId: string;
  selected: ModelCell;
  acceptedProductActualIdentities: Array<{
    provider: string;
    model: string;
    reasoningEffort: string;
    controlsHash: string;
  }>;
  route: string | null;
  trace: TraceObservation[];
  operations: OperationObservation[];
  recordKinds: Array<{ kind: string; count: number }>;
  changedArtifacts: Array<{ path: string; change: "created" | "modified" | "deleted"; sha256?: string }>;
  finalDisposition: string | null;
  runtimeChecks: Array<{ check: string; passed: boolean; detail?: string }>;
  proofGaps: string[];
  outcome?: { kind: string; contentSha256?: string };
  error?: { name: string; message: string };
};

export type ScenarioObservation = {
  schema: "butler.btcc.live-diagnostic-row.v1";
  runId: string;
  scenarioId: string;
  modelCellId: string;
  integrationSurface: "production_composition_runtime";
  fixtureCatalogSha256: string;
  turns: TurnObservation[];
  runtimeStatus: "observed" | "failed";
  proofEligible: false;
  proofGaps: string[];
  preservedRoot: string;
};

export type RunAggregate = {
  schema: "butler.btcc.live-diagnostic-aggregate.v1";
  runId: string;
  startedAt: string;
  completedAt: string;
  sourceRevision: string;
  manifestPath: string;
  manifestSha256: string;
  modelCells: ModelCell[];
  expectedScenarioCount: number;
  observedRows: number;
  rows: Array<{
    scenarioId: string;
    modelCellId: string;
    status: ScenarioObservation["runtimeStatus"];
    reportPath: string;
  }>;
  proofEligible: false;
  proofGaps: string[];
  outputRoot: string;
};
