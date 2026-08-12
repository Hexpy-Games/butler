import { existsSync } from "fs";
import { join } from "path";
import {
  estimateContextTokens,
  evaluateContextBudget,
  type ContextThresholdState,
} from "../../agent/context/budget.ts";
import { estimatePromptTokensFromSummaryStats } from "../../agent/conversation/store-internals.ts";
import { AgentConversationStore, conversationStorePath } from "../../agent/conversation/store.ts";
import { conversationSessionIdForDurableSession } from "../../agent/conversation/session-admission.ts";
import { readContextMetricSummary } from "./context-metric-summary-index.ts";
import { readTranscriptSummaryIndex } from "./transcript-summary-index.ts";
import {
  contextMetricsPath,
  type PromptAssemblyContextMetric,
  type RuntimeTurnContextMetric,
} from "./context-monitor-telemetry.ts";

export type ContextPressureLevel = "low" | "medium" | "high";
export {
  appendPromptAssemblyContextMetric,
  appendRuntimeTurnContextMetric,
  contextMetricsPath,
  contextMetricsRevision,
  readContextMetrics,
} from "./context-monitor-telemetry.ts";
export type {
  ContextMetricEvent,
  PromptAssemblyContextMetric,
  RuntimeTurnContextMetric,
} from "./context-monitor-telemetry.ts";

export interface ContextMonitorSummary {
  sessionId: string;
  telemetry: {
    events: number;
    parseErrors: number;
  };
  latestPromptAssembly: (PromptAssemblyContextMetric & { estimatedTokens: number }) | null;
  latestTurn: (RuntimeTurnContextMetric & { estimatedTokens: number }) | null;
  transcript: {
    exists: boolean;
    bytes: number;
    events: number;
    conversationEvents: number;
    latestTimestamp: string | null;
  };
  conversation: {
    exists: boolean;
    sessionId: string;
    semanticMessages: number;
    compactedMessages: number;
    summaries: number;
    latestMessageTimestamp: string | null;
    promptTokenEstimate: number;
  };
  pressure: {
    level: ContextPressureLevel;
    thresholdState: ContextThresholdState;
    totalChars: number;
    estimatedTokens: number;
    contextWindowTokens: number;
    reservedOutputTokens: number;
    reservedToolTokens: number;
    freeTokens: number;
    freeTokensAfterReserve: number;
    usedRatio: number;
    contributors: {
      systemPromptChars: number;
      turnPromptChars: number;
      semanticPromptTokens: number;
      transcriptBytes: number;
    };
  };
  privacy: {
    rawTextStored: false;
  };
}

function transcriptPathForData(butlerData: string, sessionId: string): string {
  const safeSessionId = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(butlerData, "transcripts", `${safeSessionId}.jsonl`);
}

function readTranscriptStats(butlerData: string, sessionId: string): ContextMonitorSummary["transcript"] {
  const path = transcriptPathForData(butlerData, sessionId);
  return readTranscriptSummaryIndex({
    butlerData,
    transcriptPath: path,
  });
}

function readConversationStats(butlerData: string, runtimeSessionId: string): ContextMonitorSummary["conversation"] {
  const fallbackSessionId = conversationSessionIdForDurableSession(runtimeSessionId);
  if (!existsSync(conversationStorePath(butlerData))) {
    return {
      exists: false,
      sessionId: fallbackSessionId,
      semanticMessages: 0,
      compactedMessages: 0,
      summaries: 0,
      latestMessageTimestamp: null,
      promptTokenEstimate: 0,
    };
  }
  const store = new AgentConversationStore({ butlerData });
  try {
    const canonicalSessionId = store.getSession(runtimeSessionId)
      ? runtimeSessionId
      : fallbackSessionId;
    const session = store.getSession(canonicalSessionId);
    const contextStats = store.readContextStats(canonicalSessionId, 200);
    return {
      exists: Boolean(session),
      sessionId: canonicalSessionId,
      semanticMessages: contextStats.messages.semanticMessages,
      compactedMessages: contextStats.messages.compactedMessages,
      summaries: contextStats.summaries.summaries,
      latestMessageTimestamp: contextStats.messages.latestMessageTimestamp,
      promptTokenEstimate: estimatePromptTokensFromSummaryStats(
        contextStats.semanticTail,
        {
          count: contextStats.summaries.summaries,
          textChars: contextStats.summaries.summaryTextChars,
        },
      ),
    };
  } finally {
    store.close();
  }
}

export function readContextMonitor(input: {
  butlerData: string;
  sessionId?: string;
}): ContextMonitorSummary {
  const sessionId = input.sessionId?.trim() || "butler/main";
  const telemetry = readContextMetricSummary({
    butlerData: input.butlerData,
    contextMetricsPath: contextMetricsPath(input.butlerData),
    sessionId,
  });
  const latestPrompt = telemetry.latestPrompt;
  const latestTurn = telemetry.latestTurn;
  const transcript = readTranscriptStats(input.butlerData, sessionId);
  const conversation = readConversationStats(input.butlerData, sessionId);
  const systemPromptChars = latestPrompt?.totalChars ?? 0;
  const turnPromptChars = latestTurn?.totalPromptChars ?? 0;
  const totalChars = systemPromptChars + turnPromptChars;
  const telemetryTokens = estimateContextTokens(totalChars);
  const estimatedTokens = Math.max(telemetryTokens, conversation.promptTokenEstimate);
  const budget = evaluateContextBudget({
    modelRef: latestTurn?.model ?? undefined,
    inputTokens: estimatedTokens,
  });

  return {
    sessionId,
    telemetry: {
      events: telemetry.events,
      parseErrors: telemetry.parseErrors,
    },
    latestPromptAssembly: latestPrompt
      ? {
          ...latestPrompt,
          estimatedTokens: estimateContextTokens(latestPrompt.totalChars),
        }
      : null,
    latestTurn: latestTurn
      ? {
          ...latestTurn,
          estimatedTokens: estimateContextTokens(latestTurn.totalPromptChars),
        }
      : null,
    transcript,
    conversation,
    pressure: {
      level: budget.pressureLevel,
      thresholdState: budget.thresholdState,
      totalChars,
      estimatedTokens,
      contextWindowTokens: budget.contextWindowTokens,
      reservedOutputTokens: budget.reservedOutputTokens,
      reservedToolTokens: budget.reservedToolTokens,
      freeTokens: budget.freeTokens,
      freeTokensAfterReserve: budget.freeTokensAfterReserve,
      usedRatio: budget.usedRatio,
      contributors: {
        systemPromptChars,
        turnPromptChars,
        semanticPromptTokens: conversation.promptTokenEstimate,
        transcriptBytes: transcript.bytes,
      },
    },
    privacy: {
      rawTextStored: false,
    },
  };
}
