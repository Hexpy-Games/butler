import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import type {
  BenchmarkTarget,
  BtccRevision,
  MaterializedBenchmarkPrompt,
  RawBenchmarkObservation,
  ProjectDeliverableValidation,
} from "./contracts.ts";
import { BTCC_REVISION_BENCHMARK_SCHEMA } from "./contracts.ts";
import {
  openBenchmarkAppDatabase,
  readLedgerObservation,
  resolveBenchmarkLedgerProjectId,
  tableExists,
} from "./ledger-observation.ts";
import { readValidatorRejections } from "./loop-observation.ts";
import {
  countProtocolJargon,
  eventTime,
  firstMeaningfulEventTime,
  maxSilentGap,
  readProductUsage,
  readTurnEvents,
  summarizeTools,
} from "./product-telemetry.ts";

export interface ProductObservationInput {
  artifactPaths: string[];
  evidence: Record<string, unknown>;
  fixtures: Array<{ path: string; text: string }>;
  prompt: MaterializedBenchmarkPrompt;
  revision: BtccRevision;
  runId: string;
  runRoot: string;
  target: BenchmarkTarget;
  timedOut: boolean;
  deliverableValidation?: ProjectDeliverableValidation | null;
}

export function collectRawProductObservation(
  input: ProductObservationInput,
): RawBenchmarkObservation {
  const run = record(input.evidence.run);
  const session = record(input.evidence.session);
  const step = firstRecord(input.evidence.observations);
  const launch = firstRecord(input.evidence.launches);
  const dataRoot = stringValue(run.dataRoot) ?? join(input.runRoot, "data");
  const workspaceRoot = stringValue(run.workspaceRoot) ??
    discoverWorkspace(dataRoot, input.runRoot);
  const evidencePath = join(input.runRoot, "evidence.json");
  const appDb = openBenchmarkAppDatabase(dataRoot);
  const turnId = stringValue(step.turnId) ?? latestTurnId(appDb);
  const finalText = stringValue(step.finalText) ?? finalTextForTurn(appDb, turnId);
  const timing = record(step.timing);
  const submittedAtMs = numberValue(timing.submittedAtMs) ?? turnCreatedAt(appDb, turnId);
  const events = readTurnEvents(dataRoot, turnId);
  const terminalAtMs = numberValue(timing.terminalAtMs) ??
    eventTime(events, "turn.completed") ??
    eventTime(events, "turn.failed") ??
    eventTime(events, "turn.cancelled") ??
    Date.now();
  const latencyTargetMs = benchmarkLatencyTargetMs(input.prompt);
  const hardStopMs = benchmarkHardStopMs(input.prompt);
  const terminalState = input.timedOut
    ? "timed_out"
    : normalizeTerminalState(stringValue(step.terminalState));
  const usage = readProductUsage(dataRoot, input.target, terminalAtMs);
  const allProviderRequests = readProviderRequests(input.evidence.providerRequests)
    .filter((request) => request.requestStartedAtMs <= terminalAtMs);
  const providerRequests = allProviderRequests.filter((request) =>
    request.requestKind === "agent",
  );
  const toolProviderRequests = allProviderRequests.filter((request) =>
    request.requestKind === "tool_provider",
  );
  const legacyProviderRequests = allProviderRequests.filter((request) =>
    request.requestKind === "legacy_main",
  );
  const hasLegacyProviderRequests = legacyProviderRequests.length > 0;
  const hasTypedProviderEvidence = allProviderRequests.some((request) =>
    request.requestKind !== "legacy_main",
  );
  const firstProviderRequest = [...providerRequests, ...legacyProviderRequests]
    .sort((left, right) => left.requestStartedAtMs - right.requestStartedAtMs)[0] ??
    null;
  const firstProviderDeltaAtMs = providerRequests
    .map((request) => request.firstContentBearingDeltaAtMs)
    .find((value): value is number => value !== null) ?? null;
  const tools = summarizeTools(events, terminalState === "delivered", terminalAtMs);
  const progressMessages = stringArray(step.progressMessages);
  const reload = record(step.reload);
  const beforeReload = finalMessageCount(appDb, turnId);
  const reloadMatched = booleanValue(reload.finalMatched);
  const appProjectId = stringValue(session.projectId) ?? undefined;
  const ledger = readLedgerObservation(
    appDb,
    turnId,
    input.prompt.expectedLedgerRoute,
    dataRoot,
    input.prompt.expectedLedgerRoute === "project"
      ? resolveBenchmarkLedgerProjectId({
          appProjectId,
          dataRoot,
          db: appDb,
          revision: input.revision,
          workspaceRoot,
        })
      : undefined,
  );
  const validatorRejections = readValidatorRejections(appDb, turnId);
  const unsuccessfulProviderRequests = providerRequests.filter((request) =>
    request.completedAtMs === null || request.status === null ||
    request.status < 200 || request.status >= 300,
  ).length;
  const emptySuccessfulProviderRequests = providerRequests.filter((request) =>
    request.completedAtMs !== null && request.status !== null &&
    request.status >= 200 && request.status < 300 &&
    !request.hasTextContent &&
    !request.hasToolArgumentContent,
  ).length;
  appDb?.close();
  const artifacts = input.artifactPaths.map((path) =>
    observeArtifact(workspaceRoot, path, input.fixtures),
  );
  const artifactRefs = artifacts
    .filter((artifact) => artifact.exists)
    .map((artifact) => artifact.path);
  const delivered = terminalState === "delivered";
  const productWallMs = durationMs(submittedAtMs, terminalAtMs);
  const providerEvidencePresent = allProviderRequests.length > 0;
  return {
    schema: BTCC_REVISION_BENCHMARK_SCHEMA,
    kind: "raw_product_observation",
    runId: input.runId,
    promptId: input.prompt.id,
    revision: input.revision,
    prompt: input.prompt.prompt,
    target: input.target,
    turnId,
    terminalState,
    finalText,
    text: {
      finalCharacters: characterCount(finalText),
      streamedCharacters: hasLegacyProviderRequests
        ? null
        : providerRequests.at(-1)?.streamedTextChars ?? null,
    },
    providerReportedModel: usage.model,
    quality: {
      intentScore: null,
      resultScore: null,
      requiredOutcomes: Object.fromEntries(input.prompt.requiredOutcomes.map((outcome) => [
        outcome,
        null,
      ])),
      assessmentNote: null,
    },
    usage: {
      modelRequests: hasLegacyProviderRequests
        ? usage.modelRequests
        : providerRequests.length > 0 || hasTypedProviderEvidence
          ? providerRequests.length
          : usage.modelRequests,
      promptTokens: usage.promptTokens,
      cachedPromptTokens: usage.cachedPromptTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      serializedContextBytes: hasLegacyProviderRequests
        ? null
        : providerRequests.length > 0
        ? providerRequests.reduce(
          (total, request) => total + request.serializedRequestBytes,
          0,
        )
        : null,
      toolProviderRequests: hasLegacyProviderRequests
        ? null
        : providerEvidencePresent
        ? toolProviderRequests.length
        : null,
      toolProviderElapsedMs: hasLegacyProviderRequests
        ? null
        : providerEvidencePresent
        ? toolProviderRequests.reduce(
          (total, request) => total +
            (durationMs(
              request.requestStartedAtMs,
              request.terminatedAtMs ?? request.completedAtMs,
            ) ?? 0),
          0,
        )
        : null,
    },
    timing: {
      submittedAtMs,
      acknowledgedAtMs: numberValue(timing.acknowledgedAtMs),
      admittedAtMs: eventTime(events, "turn.started") ??
        numberValue(timing.acknowledgedAtMs),
      modelRequestStartedAtMs: firstProviderRequest?.requestStartedAtMs ?? null,
      firstProviderTokenAtMs: firstProviderDeltaAtMs,
      firstMeaningfulAtMs: firstMeaningfulEventTime(events) ??
        (delivered ? terminalAtMs : null),
      finalVisibleAtMs: delivered ? terminalAtMs : null,
      terminalAtMs,
      maxSilentGapMs: maxSilentGap(events, submittedAtMs, terminalAtMs),
      latencyTargetMs,
      hardStopMs,
      latencyTargetMet: productWallMs === null
        ? null
        : delivered && productWallMs <= latencyTargetMs,
    },
    ux: {
      progressMessages,
      protocolJargonMessages: countProtocolJargon([...progressMessages, finalText]),
      userInterventions: 0,
    },
    loop: {
      noProgressTurns: validatorRejections === null || providerRequests.length === 0
        ? null
        : validatorRejections + unsuccessfulProviderRequests +
          emptySuccessfulProviderRequests,
      validatorRejections,
    },
    tools: {
      calls: tools.calls,
      failedCalls: tools.failedCalls,
      recoveredErrors: tools.recoveredErrors,
      recoveryTimeMs: tools.recoveryTimeMs,
      observations: tools.observations,
    },
    durability: {
      finalMessagesBeforeReload: beforeReload,
      finalMessagesAfterReload: reloadMatched === null
        ? null
        : reloadMatched ? beforeReload : 0,
      eventReplayParity: reloadMatched,
      continuationTested: false,
      continuationSucceeded: null,
    },
    safety: {
      unauthorizedEffects: null,
      targetEscapes: null,
      falseSuccessClaims: null,
      privacyLeaks: null,
    },
    execution: {
      runRoot: input.runRoot,
      dataRoot,
      electronUserData:
        stringValue(run.electronProfile) ?? join(input.runRoot, "electron-profile"),
      workspaceRoot,
      evidencePath,
      appBaseUrl: numberValue(run.serverPort) === null
        ? null
        : `http://127.0.0.1:${numberValue(run.serverPort)}`,
      electronDebugPort: numberValue(run.debugPort),
      electronProcessId: numberValue(launch.electronPid),
      executorProcessId: numberValue(launch.executorPid),
    },
    ledger,
    deliverableValidation: input.deliverableValidation ?? null,
    artifacts,
    artifactRefs,
  };
}

function observeArtifact(
  workspaceRoot: string,
  path: string,
  fixtures: Array<{ path: string; text: string }>,
): RawBenchmarkObservation["artifacts"][number] {
  const absolute = resolve(workspaceRoot, path);
  const inside = absolute.startsWith(`${resolve(workspaceRoot)}/`);
  if (!inside || !existsSync(absolute) || !statSync(absolute).isFile()) {
    return {
      path,
      exists: false,
      byteLength: null,
      sha256: null,
      changedFromFixture: null,
    };
  }
  const bytes = readFileSync(absolute);
  const fixture = fixtures.find((candidate) => candidate.path === path);
  return {
    path,
    exists: true,
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    changedFromFixture: fixture ? !bytes.equals(Buffer.from(fixture.text)) : true,
  };
}

function discoverWorkspace(dataRoot: string, runRoot: string): string {
  const db = openBenchmarkAppDatabase(dataRoot);
  try {
    if (db && tableExists(db, "projects")) {
      const path = db.query<{ workspace_path: string }, []>(`
        SELECT workspace_path FROM projects WHERE archived = 0
        ORDER BY created_at DESC LIMIT 1
      `).get()?.workspace_path;
      if (path) return path;
    }
  } finally {
    db?.close();
  }
  return join(runRoot, "workspace");
}

function latestTurnId(db: Database | null): string {
  if (!db || !tableExists(db, "turns")) return "";
  return db.query<{ id: string }, []>(
    "SELECT id FROM turns ORDER BY created_at DESC LIMIT 1",
  ).get()?.id ?? "";
}

function turnCreatedAt(db: Database | null, turnId: string): number | null {
  if (!db || !turnId || !tableExists(db, "turns")) return null;
  const value = db.query<{ created_at: string }, [string]>(
    "SELECT created_at FROM turns WHERE id = ? LIMIT 1",
  ).get(turnId)?.created_at;
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

function finalTextForTurn(db: Database | null, turnId: string): string {
  if (!db || !turnId || !tableExists(db, "messages")) return "";
  return db.query<{ text: string }, [string]>(`
    SELECT text FROM messages
    WHERE turn_id = ? AND role = 'assistant'
    ORDER BY created_at DESC LIMIT 1
  `).get(turnId)?.text ?? "";
}

function finalMessageCount(db: Database | null, turnId: string): number | null {
  if (!db || !turnId || !tableExists(db, "messages")) return null;
  return db.query<{ count: number }, [string]>(`
    SELECT COUNT(*) AS count FROM messages
    WHERE turn_id = ? AND role = 'assistant' AND status = 'delivered'
  `).get(turnId)?.count ?? 0;
}

function normalizeTerminalState(
  value: string | null,
): RawBenchmarkObservation["terminalState"] {
  return value === "cancelled" || value === "failed" || value === "delivered"
    ? value
    : "failed";
}

function benchmarkLatencyTargetMs(prompt: MaterializedBenchmarkPrompt): number {
  const legacyTimeoutMs = prompt.timeoutMs;
  return prompt.latencyTargetMs ?? legacyTimeoutMs ?? prompt.hardStopMs;
}

function benchmarkHardStopMs(prompt: MaterializedBenchmarkPrompt): number {
  return prompt.hardStopMs ?? prompt.timeoutMs ?? prompt.latencyTargetMs;
}

function durationMs(start: number | null, end: number | null): number | null {
  return start !== null && end !== null && end >= start ? end - start : null;
}

function characterCount(value: string): number {
  return [...value].length;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstRecord(value: unknown): Record<string, unknown> {
  return Array.isArray(value) ? record(value[0]) : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

interface ProviderRequestObservation {
  requestKind: "agent" | "legacy_main" | "tool_provider" | "title";
  requestStartedAtMs: number;
  serializedRequestBytes: number;
  firstContentBearingDeltaAtMs: number | null;
  completedAtMs: number | null;
  terminatedAtMs: number | null;
  status: number | null;
  hasTextContent: boolean;
  hasToolArgumentContent: boolean;
  streamedTextChars: number | null;
  finalTextChars: number | null;
}

function readProviderRequests(value: unknown): ProviderRequestObservation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const item = record(candidate);
    const rawRequestKind = item.requestKind;
    const requestKind = rawRequestKind === "main" ? "legacy_main" : rawRequestKind;
    const requestStartedAtMs = numberValue(item.requestStartedAtMs);
    const serializedRequestBytes = numberValue(item.serializedRequestBytes);
    if (
      (requestKind !== "agent" && requestKind !== "legacy_main" &&
        requestKind !== "tool_provider" &&
        requestKind !== "title") ||
      requestStartedAtMs === null || serializedRequestBytes === null ||
      serializedRequestBytes < 0
    ) return [];
    return [{
      requestKind,
      requestStartedAtMs,
      serializedRequestBytes,
      firstContentBearingDeltaAtMs: nullableNumber(item.firstContentBearingDeltaAtMs),
      completedAtMs: nullableNumber(item.completedAtMs),
      terminatedAtMs: nullableNumber(item.terminatedAtMs),
      status: nullableNumber(item.status),
      hasTextContent: item.hasTextContent === true,
      hasToolArgumentContent: item.hasToolArgumentContent === true,
      streamedTextChars: nullableNumber(item.streamedTextChars),
      finalTextChars: nullableNumber(item.finalTextChars),
    }];
  });
}

function nullableNumber(value: unknown): number | null {
  return value === null ? null : numberValue(value);
}
