import { estimateContextTokensForModel } from "../../context/budget.ts";
import type {
  BtccAgentLoopMessage,
  BtccAgentLoopToolDefinition,
  BtccAgentLoopToolResult,
} from "./contracts.ts";
import type {
  CompactReplayCarrierPropertyShape,
  CompactReplayCarrierRejectionReason,
} from "../compact-replay/index.ts";

export type BtccCompactReplayIdentity = {
  kind: "work" | "direct";
  result_ref: string;
  work_id?: string;
  revision: number | null;
  tool_name: string;
  status: "completed" | "failed" | "cancelled";
  result_sha256: string | null;
  outcome: "succeeded" | "failed" | "cancelled" | "unknown";
  completeness: "complete" | "incomplete";
  command_execution_summary?: {
    exit_status: number | null;
    timed_out: boolean;
    signal: string | null;
  };
};

export type BtccCompactReplayMetadata =
  | {
    kind: "source";
    identity: BtccCompactReplayIdentity;
    modelPayload?: string;
    batchIndex?: number;
  }
  | { kind: "phase_continuity"; value: unknown; batchIndex?: number }
  | {
    kind: "selected_views";
    views: Array<{ identity: BtccCompactReplayIdentity; selector: unknown; view: unknown }>;
    replayed: boolean;
    batchIndex?: number;
  }
  | {
    kind: "operation_rejected";
    code: string;
    toolName?: string;
    summary?: string;
    schemaPath?: string;
    reason?: CompactReplayCarrierRejectionReason;
    properties?: CompactReplayCarrierPropertyShape[];
    batchIndex?: number;
  };

export type BtccCompactReplaySelectedView = {
  identity: BtccCompactReplayIdentity;
  selector: unknown;
  view: unknown;
};

export type BtccCompactReplayInitialProjection = {
  openAnchors: Array<Record<string, unknown>>;
  newestBatch: Array<{
    identity: BtccCompactReplayIdentity;
    payload: unknown;
  }>;
  selectedViews: BtccCompactReplaySelectedView[];
  older: BtccCompactReplayIdentity[];
};

export type BtccCompactReplayInput = {
  enabled: boolean;
  initialPhaseContinuity: unknown;
  initialProjection?: BtccCompactReplayInitialProjection;
};

export function assembleBtccCompactReplayMessages(input: {
  compactReplay: BtccCompactReplayInput;
  messages: readonly BtccAgentLoopMessage[];
  toolResults: readonly BtccAgentLoopToolResult[];
  modelRef: string;
  instructions?: string;
  tools: readonly BtccAgentLoopToolDefinition[];
  inputCapacityTokens: number;
}): BtccAgentLoopMessage[] {
  if (!input.compactReplay.enabled) {
    return [...input.messages];
  }
  const initial = input.compactReplay.initialProjection;
  if (input.toolResults.length === 0 && !initial) return [...input.messages];
  const phaseContinuity = latestContinuity(
    input.toolResults,
    input.compactReplay.initialPhaseContinuity,
  );
  const sourceResults = input.toolResults.flatMap((result) =>
    result.compactReplay?.kind === "source"
      ? [{ result, metadata: result.compactReplay }]
      : []);
  const newestBatchIndex = sourceResults.reduce(
    (latest, item) => Math.max(latest, item.metadata.batchIndex ?? -1),
    -1,
  );
  const currentNewestBatch = sourceResults
    .filter((item) => (item.metadata.batchIndex ?? -1) === newestBatchIndex)
    .map((item) => ({
      identity: item.metadata.identity,
      payload: item.metadata.modelPayload ?? item.result.output,
    }));
  const newestBatch = currentNewestBatch.length > 0
    ? currentNewestBatch
    : [...(initial?.newestBatch ?? [])];
  const newestRefs = new Set(newestBatch.map((item) => item.identity.result_ref));
  const currentOlder = sourceResults
    .filter((item) => (item.metadata.batchIndex ?? -1) !== newestBatchIndex)
    .filter((item) => !newestRefs.has(item.metadata.identity.result_ref))
    .map((item) => item.metadata.identity);
  const older = [
    ...(initial?.older ?? []),
    ...(currentNewestBatch.length > 0
      ? (initial?.newestBatch ?? []).map((item) => item.identity)
      : []),
    ...currentOlder,
  ].filter((identity) => !newestRefs.has(identity.result_ref));
  const currentRefs = new Set(sourceResults.map((item) =>
    item.metadata.identity.result_ref));
  const openAnchors = (initial?.openAnchors ?? []).filter((anchor) =>
    typeof anchor.result_ref !== "string" || !currentRefs.has(anchor.result_ref));
  const selectedViews = dedupeSelectedViews(
    input.toolResults,
    initial?.selectedViews ?? [],
  );
  const rejectedResults = input.toolResults.filter((result) =>
    result.compactReplay?.kind === "operation_rejected");
  const newestRejectionBatchIndex = rejectedResults.reduce(
    (latest, result) => Math.max(
      latest,
      result.compactReplay?.batchIndex ?? -1,
    ),
    -1,
  );
  const operationRejections = rejectedResults.flatMap((result) =>
    result.compactReplay?.kind === "operation_rejected" &&
      (result.compactReplay.batchIndex ?? -1) === newestRejectionBatchIndex
      ? [{
          kind: "operation_rejected" as const,
          code: result.compactReplay.code,
          ...(result.compactReplay.toolName
            ? { tool_name: result.compactReplay.toolName }
            : {}),
          ...(result.compactReplay.summary
            ? { summary: result.compactReplay.summary }
            : {}),
          ...(result.compactReplay.schemaPath
            ? { schema_path: result.compactReplay.schemaPath }
            : {}),
          ...(result.compactReplay.reason
            ? { reason: result.compactReplay.reason }
            : {}),
          ...(result.compactReplay.properties
            ? { properties: result.compactReplay.properties }
            : {}),
        }]
      : []);
  const retainedMessages = input.messages.flatMap((message, index) => {
    if (index === 0 || message.role === "user") return [message];
    if (message.role === "assistant" && message.content.trim()) {
      return [{ role: "assistant" as const, content: message.content }];
    }
    return [];
  });
  while (true) {
    const projection = renderProjection({
      phaseContinuity,
      openAnchors,
      newestBatch,
      selectedViews,
      older,
      operationRejections,
    });
    const messages = [
      ...retainedMessages,
      { role: "user" as const, content: projection },
    ];
    const estimatedTokens = estimateContextTokensForModel(JSON.stringify({
      messages,
      instructions: input.instructions ?? null,
      tools: input.tools,
    }), input.modelRef).tokens;
    if (estimatedTokens <= input.inputCapacityTokens) return messages;
    const oldestView = selectedViews.shift();
    if (oldestView) {
      older.push(oldestView.identity);
      continue;
    }
    throw new Error("compact_replay_required_context_overflow");
  }
}

function latestContinuity(
  results: readonly BtccAgentLoopToolResult[],
  initial: unknown,
): unknown {
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const metadata = results[index]?.compactReplay;
    if (metadata?.kind === "phase_continuity") return metadata.value;
  }
  return initial;
}

function dedupeSelectedViews(
  results: readonly BtccAgentLoopToolResult[],
  initial: readonly BtccCompactReplaySelectedView[],
): BtccCompactReplaySelectedView[] {
  const selected = [...initial, ...results.flatMap((result) =>
    result.compactReplay?.kind === "selected_views"
      ? result.compactReplay.views
      : [])];
  const latestByIdentity = new Map<string, (typeof selected)[number]>();
  for (const view of selected) {
    const key = JSON.stringify([view.identity.result_ref, view.selector]);
    if (latestByIdentity.has(key)) latestByIdentity.delete(key);
    latestByIdentity.set(key, view);
  }
  return [...latestByIdentity.values()];
}

function renderProjection(input: {
  phaseContinuity: unknown;
  openAnchors: Array<Record<string, unknown>>;
  newestBatch: Array<{ identity: BtccCompactReplayIdentity; payload: unknown }>;
  selectedViews: BtccCompactReplaySelectedView[];
  older: BtccCompactReplayIdentity[];
  operationRejections: Array<{
    kind: "operation_rejected";
    code: string;
    tool_name?: string;
    summary?: string;
    schema_path?: string;
    reason?: CompactReplayCarrierRejectionReason;
    properties?: CompactReplayCarrierPropertyShape[];
  }>;
}): string {
  return [
    "## Canonical compact replay for this phase",
    "Model-authored PhaseContinuity:",
    JSON.stringify(input.phaseContinuity),
    "Required open operation anchors:",
    JSON.stringify(input.openAnchors),
    "Newest completed source batch:",
    JSON.stringify(input.newestBatch),
    "Distinct selected exact views:",
    JSON.stringify(input.selectedViews),
    "Same-phase rejected compact operations:",
    JSON.stringify(input.operationRejections),
    "Older operation identity index:",
    JSON.stringify(dedupeIdentities(input.older)),
    "Use read_operation_results for an older exact view. Never rerun its source operation.",
  ].join("\n");
}

function dedupeIdentities(
  identities: readonly BtccCompactReplayIdentity[],
): BtccCompactReplayIdentity[] {
  const latest = new Map<string, BtccCompactReplayIdentity>();
  for (const identity of identities) latest.set(identity.result_ref, identity);
  return [...latest.values()];
}
