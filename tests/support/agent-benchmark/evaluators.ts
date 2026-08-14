import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import type {
  AdapterRunResult,
  BenchmarkArmPlan,
  BenchmarkFixture,
  BenchmarkGateCode,
  BenchmarkObservation,
  BenchmarkTerminalState,
  EvaluationMetrics,
  EffectiveAgentConfig,
  OperationMetrics,
  PrivacyMetrics,
  TokenUsage,
  ToolMetrics,
  TimingMetrics,
} from "./contracts.ts";
import { AGENT_BENCHMARK_SCHEMA } from "./contracts.ts";
import { boundedText } from "./command.ts";
import { evaluateWebResearch } from "./web-evaluator.ts";
import { landingClaimMatches } from "./landing-evaluator.ts";
import { sanitizeEffectiveConfig } from "./identifiers.ts";
import { directConversationClaimMatches } from "./direct-evaluator.ts";
import { evaluateM1V2AdapterEvidence } from "./m1-v2-adapter-evaluation.ts";
import { corroboratePairedRequestEvidence } from "./paired-contract.ts";
import { comparableIdentityForArm } from "./paired-evaluation.ts";
export { evaluateWebResearch } from "./web-evaluator.ts";

export interface EvaluationContext {
  gateCode?: BenchmarkGateCode;
  sourceMutation?: boolean;
  repositoryEvidenceRoot?: string;
  diagnostics?: readonly string[];
  pairedAuthReceipt?: import("./paired-contract.ts").ProviderAuthPreflight;
}

export function evaluateAdapterResult(
  arm: BenchmarkArmPlan,
  fixture: BenchmarkFixture,
  result: AdapterRunResult,
  context: EvaluationContext = {},
): BenchmarkObservation {
  const diagnostics = [...(context.diagnostics ?? [])];
  const privacy = evaluatePrivacy(result, arm, fixture);
  const scopeViolation = context.sourceMutation === true || pathEscapes(arm.outputRoot, result.changedPaths);
  if (scopeViolation) diagnostics.push("source-or-output-scope-violation");
  const rawEffectiveConfig = { ...arm.effectiveConfig, ...result.effectiveConfig };
  const effectiveConfig = sanitizeEffectiveConfig(rawEffectiveConfig) as EffectiveAgentConfig;
  const configGate = effectiveModelGate(arm, result, effectiveConfig);
  if (configGate.diagnostic) diagnostics.push(configGate.diagnostic);
  const gateCode = result.gateCode !== "none" ? result.gateCode : context.gateCode ?? configGate.gateCode ?? "none";
  let terminalState = terminalStateFor(result, gateCode, scopeViolation);
  if (arm.version) {
    try {
      const evidence = result.pairedExecutionEvidence;
      const preregistered = arm.pairedExecution;
      if (!preregistered) throw new Error("paired_execution_preregistration_missing");
      const receipt = context.pairedAuthReceipt;
      if (!receipt) throw new Error("provider_auth_receipt_missing");
      corroboratePairedRequestEvidence(preregistered, receipt, evidence);
    } catch (error) {
      diagnostics.push(error instanceof Error ? error.message : String(error));
      terminalState = "rejected";
    }
  }
  const executionRejected = terminalState === "rejected";
  const m1Evaluation = evaluateM1V2AdapterEvidence({ arm, fixture, result, terminalState });
  const m1V2 = m1Evaluation.summary;
  terminalState = executionRejected ? "rejected" : m1Evaluation.terminalState;
  diagnostics.push(...m1Evaluation.diagnostics);
  const evaluation = evaluateFixture(arm, fixture, result, terminalState, privacy, scopeViolation, context.repositoryEvidenceRoot);
  if (terminalState === "accepted" && evaluation.accepted !== true) terminalState = "rejected";
  const usage = normalizeUsage(result.usage);
  const acceptedResultPerToken = deriveAcceptedResultPerToken(
    terminalState,
    usage.totalTokens,
    evaluation.accepted,
  );
  return {
    schema: AGENT_BENCHMARK_SCHEMA,
    kind: "agent_benchmark_observation",
    arm,
    terminalState,
    gateCode,
    adapterVersion: result.adapterVersion ?? null,
    effectiveConfig,
    usage,
    tools: normalizeTools(result.tools),
    timing: normalizeTiming(result.timing),
    operations: normalizeOperations(result.operations),
    evaluation,
    visualReview: null,
    privacy,
    acceptedResultPerToken,
    promptHash: hashText(fixture.prompts.join("\n\n")),
    answerHash: result.finalText ? hashText(result.finalText) : null,
    changedPaths: result.changedPaths,
    diagnostics: diagnostics.map((value) => boundedText(value)).slice(-8),
    evidenceRefs: safeEvidenceRefs(result.evidenceRefs),
    providerDispatchState: result.providerDispatchState ?? (result.pairedExecutionEvidence?.providerServiceTiers.length
      ? (result.finalText ? "provider_output_observed" : "provider_dispatched")
      : "adapter_entered"),
    infrastructureGateStage: null,
    pairedComparableIdentity: comparableIdentityForArm(arm, m1V2, pairedRuntimeIdentity(arm, result, context)),
    m1V2,
  };
}
function pairedRuntimeIdentity(arm: BenchmarkArmPlan, result: AdapterRunResult, context: EvaluationContext) {
  const evidence = result.pairedExecutionEvidence, receipt = context.pairedAuthReceipt;
  const exact = (values: readonly (string | null)[]): string | null => {
    const present = [...new Set(values)]; return present.length === 1 && typeof present[0] === "string" ? present[0] : null;
  };
  const model = evidence ? exact(evidence.requestModels) : null, reasoning = evidence ? exact(evidence.requestReasoning) : null,
    route = evidence ? exact(evidence.routeIds) : null;
  if (!evidence || !receipt || !model || !reasoning || !route || !arm.pairedExecution) return null;
  return { provider: evidence.provider, model, reasoning, route, authMode: receipt.authMode,
    executionMode: arm.pairedExecution.executionMode };
}

export function deriveAcceptedResultPerToken(
  terminalState: BenchmarkTerminalState,
  totalTokens: number | null,
  accepted: boolean | null,
): number | null {
  if (terminalState !== "accepted" || accepted !== true || totalTokens === null || totalTokens <= 0) {
    return null;
  }
  return 1_000_000 / totalTokens;
}

function terminalStateFor(
  result: AdapterRunResult,
  gateCode: BenchmarkGateCode,
  scopeViolation: boolean,
): BenchmarkTerminalState {
  if (gateCode !== "none") return "gated";
  if (result.timedOut) return "timed_out";
  if (result.cancelled) return "failed";
  if (result.exitCode === null) return "failed";
  if (scopeViolation) return "rejected";
  return result.exitCode === 0 ? "accepted" : "failed";
}

function effectiveModelGate(
  arm: BenchmarkArmPlan,
  result: AdapterRunResult,
  effectiveConfig: EffectiveAgentConfig,
): { gateCode: BenchmarkGateCode | null; diagnostic: string | null } {
  const rawObserved = result.effectiveConfig?.model;
  if (rawObserved !== undefined && rawObserved !== null && effectiveConfig.model === null) {
    return { gateCode: "configuration_unverifiable", diagnostic: "Observed effective model identifier was unsafe." };
  }
  const observed = effectiveConfig.model;
  if (arm.track === "controlled") {
    if (!observed) return { gateCode: "measurement_unavailable", diagnostic: "Controlled effective model was not observable." };
    if (observed !== arm.effectiveConfig.model) return { gateCode: "configuration_unverifiable", diagnostic: "Controlled effective model differed from the requested model." };
  } else if (!observed) {
    return { gateCode: "measurement_unavailable", diagnostic: "Recommended-default effective model was not observable." };
  }
  return { gateCode: null, diagnostic: null };
}

function evaluateFixture(
  arm: BenchmarkArmPlan,
  fixture: BenchmarkFixture,
  result: AdapterRunResult,
  terminalState: BenchmarkTerminalState,
  privacy: PrivacyMetrics,
  scopeViolation: boolean,
  repositoryEvidenceRoot?: string,
): EvaluationMetrics {
  if (fixture.id === "current_web_research") {
    const web = evaluateWebResearch(result.finalText, fixture);
    return {
      ...web,
      accepted: terminalState === "accepted" && web.accepted === true && !privacyViolation(privacy),
      visualQuality: null,
      evidenceRefs: safeEvidenceRefs(result.evidenceRefs),
    };
  }
  const notes: string[] = [];
  const text = result.finalText?.toLowerCase() ?? "";
  const claimMatches = fixture.id === "direct_conversation"
    ? directConversationClaimMatches(text).filter(Boolean).length
    : landingClaimMatches(arm, fixture, repositoryEvidenceRoot);
  const factualAccuracy = fixture.expectedClaims?.length
    ? claimMatches / fixture.expectedClaims.length
    : null;
  let accepted = terminalState === "accepted" && (fixture.id === "butler_landing_page" || Boolean(result.finalText));
  if (fixture.id === "butler_landing_page") {
    const missing = (fixture.expectedFiles ?? []).filter((path) => !existsSync(resolve(arm.outputRoot, path)));
    if (missing.length > 0) notes.push(`missing-output:${missing.join(",")}`);
    if (result.operations.build?.passed !== true) notes.push("build-not-passed");
    if (result.operations.tests?.passed !== true) notes.push("tests-not-passed");
    const landing = result.landingValidation;
    if (!landing?.browserAvailable || !landing.desktop.loaded || !landing.mobile.loaded || !landing.desktop.overflowFree || !landing.mobile.overflowFree) notes.push("render-validation-failed");
    if (factualAccuracy !== 1) notes.push("landing-claims-or-citations-incomplete");
    accepted = accepted && missing.length === 0 && factualAccuracy === 1 && notes.length === 0 && !scopeViolation;
  } else if (factualAccuracy !== null && factualAccuracy < 1) {
    notes.push("direct-claims-incomplete");
    accepted = false;
  }
  if (privacyViolation(privacy)) {
    notes.push("privacy-violation");
    accepted = false;
  }
  return {
    accepted,
    factualAccuracy,
    sourceQuality: fixture.id === "direct_conversation" ? null : fixture.id === "butler_landing_page" ? factualAccuracy : 0,
    visualQuality: fixture.id === "butler_landing_page" ? result.landingValidation?.visualQuality ?? null : null,
    resultQuality: accepted ? 5 : Math.max(1, Math.round((factualAccuracy ?? 0) * 4)),
    evaluatorNotes: notes,
    evidenceRefs: safeEvidenceRefs(result.evidenceRefs),
  };
}
function evaluatePrivacy(
  result: AdapterRunResult,
  arm: BenchmarkArmPlan,
  fixture: BenchmarkFixture,
): PrivacyMetrics {
  const text = `${result.finalText ?? ""}\n${result.stderr}`;
  const promptLeak = fixture.prompts.some((prompt) => prompt.length > 40 && text.includes(prompt));
  const credentialLeak = /(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]/iu.test(text);
  // Raw stdout is transient and intentionally discarded. Parsed tool metrics
  // contain only bounded names/statuses, so payload-shaped stdout is not a
  // persisted leak by itself.
  const rawToolPayloadLeak = false;
  const privatePathLeak = /(?:\/Users\/|\/home\/|[A-Z]:\\)/u.test(text) ||
    result.changedPaths.some((path) => isAbsolute(path));
  const hiddenReasoningLeak = /<\/?thinking>|chain[- ]of[- ]thought|private reasoning/iu.test(text);
  return {
    redacted: !credentialLeak && !privatePathLeak && !rawToolPayloadLeak && !hiddenReasoningLeak,
    promptLeak,
    credentialLeak,
    rawToolPayloadLeak,
    privatePathLeak: privatePathLeak || arm.sourceRoot.includes("/Users/") && text.includes(arm.sourceRoot),
    hiddenReasoningLeak,
  };
}

function normalizeUsage(usage: Partial<TokenUsage>): TokenUsage {
  const inputTokens = numberOrNull(usage.inputTokens);
  const outputTokens = numberOrNull(usage.outputTokens);
  return {
    inputTokens,
    cacheReadTokens: numberOrNull(usage.cacheReadTokens),
    cacheWriteTokens: numberOrNull(usage.cacheWriteTokens),
    outputTokens,
    totalTokens: numberOrNull(usage.totalTokens) ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null),
    modelRequests: numberOrNull(usage.modelRequests),
  };
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEvidenceRefs(refs: readonly string[]): string[] {
  return refs.filter((ref) => !ref.startsWith("/") && !/[A-Z]:\\/u.test(ref)).slice(0, 16);
}

function normalizeTools(tools: Partial<ToolMetrics>): ToolMetrics {
  const records = tools.records ?? [];
  return {
    calls: tools.calls === undefined ? records.length : numberOrNull(tools.calls),
    failedCalls: tools.failedCalls === undefined ? records.filter((record) => record.status === "failed").length : numberOrNull(tools.failedCalls),
    records: records.slice(0, 256),
  };
}

function normalizeTiming(timing: Partial<TimingMetrics>): TimingMetrics {
  return {
    submittedAtMs: numberOrNull(timing.submittedAtMs),
    firstUsefulOutputAtMs: numberOrNull(timing.firstUsefulOutputAtMs),
    terminalAtMs: numberOrNull(timing.terminalAtMs),
    totalElapsedMs: numberOrNull(timing.totalElapsedMs),
  };
}

function normalizeOperations(operations: Partial<OperationMetrics>): OperationMetrics {
  return {
    userInterventions: numberOrNull(operations.userInterventions),
    retries: numberOrNull(operations.retries),
    changedFiles: numberOrNull(operations.changedFiles),
    tests: {
      ran: operations.tests?.ran ?? null,
      passed: operations.tests?.passed ?? null,
      command: operations.tests?.command ?? null,
    },
    build: {
      ran: operations.build?.ran ?? null,
      passed: operations.build?.passed ?? null,
      command: operations.build?.command ?? null,
    },
  };
}
function pathEscapes(root: string, paths: readonly string[]): boolean {
  return paths.some((path) => {
    const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
    const rel = relative(resolve(root), absolute);
    return rel === ".." || rel.startsWith("../") || isAbsolute(rel);
  });
}
function privacyViolation(privacy: PrivacyMetrics): boolean {
  return privacy.credentialLeak || privacy.rawToolPayloadLeak || privacy.privatePathLeak || privacy.hiddenReasoningLeak;
}
function numberOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
