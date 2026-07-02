import {
  AgentConversationStore,
  conversationMessagesSourceHash,
} from "../conversation/store.ts";
import { conversationSessionIdForDurableSession } from "../conversation/session-admission.ts";
import {
  estimateContextTokens,
  evaluateWorkingContextBudget,
  evaluateContextBudget,
  trimTextToTokenBudget,
  type ContextBudgetOverrides,
} from "./budget.ts";
import {
  chunkMessages,
  compactionWindow,
  effectiveWorkingTextAfterCompaction,
  messageText,
  summarizeMessages,
} from "./compaction-message-window.ts";
import {
  appendCompactionMetric,
  appendSnapshot,
  readLatestCompactionSnapshot,
  safeDiagnosticCode,
  withCompactionLock,
  type CompactionSnapshot,
} from "./compaction-records.ts";
import { createCompactionSnapshot } from "./compaction-snapshot-builder.ts";

export {
  compactionMetricsPath,
  compactionPath,
  readCompactionMetrics,
  readCompactionSnapshots,
  readLatestCompactionSnapshot,
  renderCompactionContext,
  type CompactionMetricEvent,
  type CompactionSnapshot,
} from "./compaction-records.ts";

export interface CompactTranscriptOptions {
  butlerData: string;
  sessionId: string;
  modelRef?: string | null;
  trigger: CompactionSnapshot["trigger"];
  preserveLastEvents?: number;
  preserveLastMessages?: number;
  chunkTokenBudget?: number;
  summaryTokenBudget?: number;
  budgetOverrides?: ContextBudgetOverrides;
  now?: () => string;
}

export async function compactTranscript(options: CompactTranscriptOptions): Promise<CompactionSnapshot> {
  const startedMs = Date.now();
  return await withCompactionLock(options.butlerData, options.sessionId, async () => {
    const store = new AgentConversationStore({ butlerData: options.butlerData });
    try {
      return compactWithStore({ store, options, startedMs });
    } finally {
      store.close();
    }
  });
}

export async function maybeAutoCompactSession(input: {
  butlerData: string;
  sessionId: string;
  modelRef?: string | null;
  budgetOverrides?: ContextBudgetOverrides;
}): Promise<CompactionSnapshot | null> {
  const store = new AgentConversationStore({ butlerData: input.butlerData });
  try {
    const canonicalSessionId = resolveCanonicalSessionId(store, input.sessionId);
    const messages = store.readMessages({
      sessionId: canonicalSessionId,
      includeCompacted: false,
      limit: 5000,
    });
    const rawTokens = estimateContextTokens(messages.map(messageText).join("\n"));
    const latest = readLatestCompactionSnapshot({
      butlerData: input.butlerData,
      sessionId: canonicalSessionId,
    });
    const effectiveWorkingTokens = estimateContextTokens(effectiveWorkingTextAfterCompaction(messages, latest));
    const budget = evaluateWorkingContextBudget({
      modelRef: input.modelRef,
      workingContextTokens: effectiveWorkingTokens,
      overrides: input.budgetOverrides,
    });
    if (!budget.shouldAutoCompact) return null;
    if (latest && latest.pre_estimated_tokens >= rawTokens) return null;
    return await compactTranscript({
      butlerData: input.butlerData,
      sessionId: canonicalSessionId,
      modelRef: input.modelRef,
      trigger: "auto",
      budgetOverrides: input.budgetOverrides,
    });
  } finally {
    store.close();
  }
}

export function writeFailedCompactionDiagnostic(input: {
  butlerData: string;
  sessionId: string;
  modelRef?: string | null;
  reason: string;
}): CompactionSnapshot {
  const now = new Date().toISOString();
  const snapshot: CompactionSnapshot = {
    schema: "butler.context.compaction.v1",
    snapshot_id: `cmp_failed_${Date.now().toString(36)}`,
    session_id: input.sessionId,
    trigger: "auto",
    status: "failed",
    created_at: now,
    model_ref: input.modelRef ?? null,
    model_context_window_tokens: 0,
    pre_estimated_tokens: 0,
    post_estimated_tokens: 0,
    summarized_event_range: {
      first_event_id: null,
      last_event_id: null,
      event_count: 0,
    },
    preserved_suffix_event_ids: [],
    summary: "",
    provenance: [],
    diagnostics: [safeDiagnosticCode(input.reason)],
  };
  appendSnapshot(input.butlerData, input.sessionId, snapshot);
  appendCompactionMetric({
    butlerData: input.butlerData,
    snapshot,
    durationMs: 0,
  });
  return snapshot;
}

function compactWithStore(input: {
  store: AgentConversationStore;
  options: CompactTranscriptOptions;
  startedMs: number;
}): CompactionSnapshot {
  const canonicalSessionId = resolveCanonicalSessionId(input.store, input.options.sessionId);
  const messages = input.store.readMessages({
    sessionId: canonicalSessionId,
    includeCompacted: false,
    limit: 5000,
  });
  const preserveLastMessages = Math.max(
    2,
    input.options.preserveLastMessages ?? input.options.preserveLastEvents ?? 8,
  );
  const window = compactionWindow(messages, preserveLastMessages);
  const preText = messages.map(messageText).join("\n");
  const preTokens = estimateContextTokens(preText);
  const budget = evaluateContextBudget({
    modelRef: input.options.modelRef,
    inputTokens: preTokens,
    overrides: input.options.budgetOverrides,
  });
  const workingBudget = evaluateWorkingContextBudget({
    modelRef: input.options.modelRef,
    workingContextTokens: preTokens,
    overrides: input.options.budgetOverrides,
  });
  const now = input.options.now?.() ?? new Date().toISOString();
  const chunkTokenBudget = Math.max(
    500,
    input.options.chunkTokenBudget ?? Math.floor(budget.contextWindowTokens * 0.20),
  );
  const summaryTokenBudget = input.options.summaryTokenBudget
    ? Math.max(200, input.options.summaryTokenBudget)
    : Math.max(200, Math.min(1_200, Math.floor(budget.contextWindowTokens * 0.15)));
  const diagnostics: string[] = [];
  let summary = buildSummary({
    messages: window.toSummarize,
    chunkTokenBudget,
    summaryTokenBudget,
    diagnostics,
  });
  const status: CompactionSnapshot["status"] = summary.trim() || window.toSummarize.length === 0 ? "ok" : "failed";
  if (status === "failed") diagnostics.push("summary_empty");
  const preservedTokens = estimateContextTokens(window.preserved.map(messageText).join("\n"));
  const maxSummaryTokens = Math.max(100, preTokens - preservedTokens - 1);
  summary = trimTextToTokenBudget(summary, Math.min(summaryTokenBudget, maxSummaryTokens), { from: "start" });
  const postTokens = estimateContextTokens(summary) + preservedTokens;
  const sourceHash = window.toSummarize.length > 0
    ? conversationMessagesSourceHash(window.toSummarize)
    : null;
  if (status === "ok" && window.toSummarize.length > 0 && sourceHash) {
    input.store.writeSummary({
      sessionId: canonicalSessionId,
      coversFromSeq: window.toSummarize[0]!.seq,
      coversToSeq: window.toSummarize.at(-1)!.seq,
      sourceHash,
      summaryText: summary.trim(),
      model: input.options.modelRef ?? null,
      now,
    });
  }
  const snapshot = createCompactionSnapshot({
    canonicalSessionId,
    trigger: input.options.trigger,
    modelRef: input.options.modelRef,
    now,
    preTokens,
    postTokens,
    sourceHash,
    summary,
    window,
    diagnostics,
    contextWindowTokens: budget.contextWindowTokens,
    workingBudget,
  });
  appendSnapshot(input.options.butlerData, canonicalSessionId, snapshot);
  appendCompactionMetric({
    butlerData: input.options.butlerData,
    snapshot,
    durationMs: Date.now() - input.startedMs,
  });
  return snapshot;
}

function buildSummary(input: {
  messages: ReturnType<typeof compactionWindow>["toSummarize"];
  chunkTokenBudget: number;
  summaryTokenBudget: number;
  diagnostics: string[];
}): string {
  if (input.messages.length === 0) {
    input.diagnostics.push("no_messages_to_summarize");
    return "";
  }
  if (estimateContextTokens(input.messages.map(messageText).join("\n")) <= input.chunkTokenBudget) {
    return summarizeMessages(input.messages, input.summaryTokenBudget);
  }
  input.diagnostics.push("hierarchical_chunk_compaction");
  const chunkSummaries = chunkMessages(input.messages, input.chunkTokenBudget)
    .map((chunk, index) =>
      `Chunk ${index + 1}: ${summarizeMessages(chunk, Math.max(250, Math.floor(input.summaryTokenBudget / 2)))}`,
    );
  return trimTextToTokenBudget(chunkSummaries.join("\n\n"), input.summaryTokenBudget, { from: "start" });
}

function resolveCanonicalSessionId(store: AgentConversationStore, runtimeSessionId: string): string {
  return store.getSession(runtimeSessionId)
    ? runtimeSessionId
    : conversationSessionIdForDurableSession(runtimeSessionId);
}
