import { Buffer } from "node:buffer";
import { digest } from "../identity/index.ts";
import {
  turnItemOrdinal,
} from "../ports/bounded-provider-continuation.ts";
import type {
  ContextProjectionRebaseIdentity,
  ModelRoundMessage,
  ModelRoundToolCall,
  OperationResultReferenceCarrier,
  PhaseContinuityPrivateDigester,
} from "../ports/model-round.ts";
import {
  isPhaseContinuityProjectionError,
  PhaseContinuityProjectionError,
} from "../ports/model-round.ts";

export const PHASE_CONTINUITY_PROJECTION_SCHEMA =
  "butler.phase-continuity-projection.v1" as const;
export const CONTEXT_PROJECTION_REBASE_SCHEMA =
  "butler.context-projection-rebase.v1" as const;
export const PHASE_CONTINUITY_PROJECTION_MAX_BYTES = 16 * 1024;

type ProjectableUnit = {
  messages: readonly ModelRoundMessage[];
  assistant: ModelRoundMessage;
  results: ReadonlyMap<string, ModelRoundMessage>;
  sourceOrdinal: number;
};

type DetailedEntry = {
  kind: "detailed";
  source_ordinal: number;
  assistant_text: { present: boolean; utf8_bytes: number; keyed_digest: string };
  calls: Array<{
    call_id: string;
    tool_name: string;
    argument_keyed_digest: string;
    terminal_success: boolean;
    result_reference: OperationResultReferenceCarrier;
  }>;
};

type ReferenceEntry = {
  kind: "reference";
  source_ordinal: number;
  unit_keyed_digest: string;
  calls: Array<{ tool_name: string; result_ref: string; result_sha256: string }>;
};

type ProjectionEntry = DetailedEntry | ReferenceEntry;
type ProjectionRange = { units: ProjectableUnit[]; entries: ProjectionEntry[] };

export function projectPhaseContinuity(input: {
  messages: readonly ModelRoundMessage[];
  digester: PhaseContinuityPrivateDigester;
  serializedBytes(messages: readonly ModelRoundMessage[]): number;
}): {
  messages: readonly ModelRoundMessage[];
  identity?: ContextProjectionRebaseIdentity;
} {
  try {
    return projectPhaseContinuityInternal(input);
  } catch (error) {
    if (isPhaseContinuityProjectionError(error)) throw error;
    throw new PhaseContinuityProjectionError(
      "phase_continuity_projection_invalid_state",
      { cause: error },
    );
  }
}

function projectPhaseContinuityInternal(input: {
  messages: readonly ModelRoundMessage[];
  digester: PhaseContinuityPrivateDigester;
  serializedBytes(messages: readonly ModelRoundMessage[]): number;
}): {
  messages: readonly ModelRoundMessage[];
  identity?: ContextProjectionRebaseIdentity;
} {
  const ranges = eligibleRanges(input.messages, input.digester);
  if (ranges.length === 0) return { messages: input.messages };
  downgradeToBound(ranges, input.digester, input.serializedBytes);

  const replacements = new Map<number, { through: number; message: ModelRoundMessage }>();
  for (const range of ranges) {
    const synthetic = syntheticMessage(range);
    const exact = range.units.flatMap((unit) => unit.messages);
    if (statelessBytes(input.serializedBytes, [synthetic]) >=
        statelessBytes(input.serializedBytes, exact)) continue;
    const firstIndex = input.messages.indexOf(range.units[0]!.messages[0]!);
    const lastUnit = range.units.at(-1)!;
    const lastIndex = input.messages.indexOf(lastUnit.messages.at(-1)!);
    replacements.set(firstIndex, { through: lastIndex, message: synthetic });
  }
  if (replacements.size === 0) return { messages: input.messages };

  const messages: ModelRoundMessage[] = [];
  for (let index = 0; index < input.messages.length; index += 1) {
    const replacement = replacements.get(index);
    if (!replacement) {
      messages.push(input.messages[index]!);
      continue;
    }
    messages.push(replacement.message);
    index = replacement.through;
  }
  if (statelessBytes(input.serializedBytes, messages) >=
      statelessBytes(input.serializedBytes, input.messages)) {
    return { messages: input.messages };
  }
  return {
    messages,
    identity: phaseContinuityProjectionIdentity(messages),
  };
}

export function phaseContinuityProjectionIdentity(
  messages: readonly ModelRoundMessage[],
): ContextProjectionRebaseIdentity | undefined {
  const synthetic = messages.filter((message) =>
    message.requestSegmentKind === "phase_continuity" &&
    message.content.includes(PHASE_CONTINUITY_PROJECTION_SCHEMA),
  );
  if (synthetic.length === 0) return undefined;
  const projectedThroughOrdinal = Math.max(...synthetic.map((message) =>
    turnItemOrdinal(message.continuationItemId),
  ));
  const projectionDigest = digest(JSON.stringify(synthetic.map((message) => ({
    ordinal: turnItemOrdinal(message.continuationItemId),
    content: message.content,
  }))));
  return {
    schemaVersion: CONTEXT_PROJECTION_REBASE_SCHEMA,
    projectionRevision: PHASE_CONTINUITY_PROJECTION_SCHEMA,
    projectionDigest,
    projectedThroughOrdinal,
  };
}

function eligibleRanges(
  messages: readonly ModelRoundMessage[],
  digester: PhaseContinuityPrivateDigester,
): ProjectionRange[] {
  const units = conversationUnits(messages);
  const newestAssistantTool = units.findLastIndex((unit) =>
    unit.some((message) => message.role === "assistant" || message.role === "tool"),
  );
  const ranges: ProjectionRange[] = [];
  let current: ProjectableUnit[] = [];
  const flush = () => {
    if (current.length > 0) {
      ranges.push({ units: current, entries: current.map((unit) => detailedEntry(unit, digester)) });
      current = [];
    }
  };
  units.forEach((unit, index) => {
    const projectable = index === newestAssistantTool ? null : projectableUnit(unit);
    if (!projectable) {
      flush();
      return;
    }
    current.push(projectable);
  });
  flush();
  return ranges;
}

function conversationUnits(messages: readonly ModelRoundMessage[]): ModelRoundMessage[][] {
  const units: ModelRoundMessage[][] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index]!;
    if (message.role === "tool") throw new Error("turn_tool_protocol_orphan");
    if (message.role !== "assistant" || !message.toolCalls?.length) {
      units.push([message]);
      index += 1;
      continue;
    }
    const unit = [message];
    let cursor = index + 1;
    while (cursor < messages.length && messages[cursor]!.role === "tool") {
      unit.push(messages[cursor]!);
      cursor += 1;
    }
    units.push(unit);
    index = cursor;
  }
  return units;
}

function projectableUnit(messages: readonly ModelRoundMessage[]): ProjectableUnit | null {
  const assistant = messages[0];
  if (assistant?.role !== "assistant" || !assistant.toolCalls?.length) return null;
  const results = new Map<string, ModelRoundMessage>();
  for (const message of messages.slice(1)) {
    if (message.role !== "tool" || !message.toolCallId || results.has(message.toolCallId)) {
      throw new Error("turn_tool_protocol_orphan");
    }
    results.set(message.toolCallId, message);
  }
  if (assistant.toolCalls.some((call) => !results.has(call.id))) return null;
  if ([...results.keys()].some((id) => !assistant.toolCalls!.some((call) => call.id === id))) {
    throw new Error("turn_tool_protocol_orphan");
  }
  // Replay attaches this carrier only after acknowledged delivery has been
  // promoted to reference-only. Raw, pending and in-flight results have none.
  if ([...results.values()].some((message) => !message.operationResultReference)) return null;
  const sourceOrdinal = Math.max(...messages.map((message) =>
    turnItemOrdinal(message.continuationItemId),
  ));
  return { messages, assistant, results, sourceOrdinal };
}

function detailedEntry(
  unit: ProjectableUnit,
  digester: PhaseContinuityPrivateDigester,
): DetailedEntry {
  const content = unit.assistant.content;
  return {
    kind: "detailed",
    source_ordinal: unit.sourceOrdinal,
    assistant_text: {
      present: content.length > 0,
      utf8_bytes: Buffer.byteLength(content, "utf8"),
      keyed_digest: keyedDigest(digester, "assistant_text", content),
    },
    calls: unit.assistant.toolCalls!.map((call) => detailedCall(call, unit, digester)),
  };
}

function detailedCall(
  call: ModelRoundToolCall,
  unit: ProjectableUnit,
  digester: PhaseContinuityPrivateDigester,
): DetailedEntry["calls"][number] {
  const reference = unit.results.get(call.id)!.operationResultReference!;
  return {
    call_id: call.id,
    tool_name: call.name,
    argument_keyed_digest: keyedDigest(digester, "tool_arguments", call.rawArguments),
    terminal_success: reference.outcome.success,
    result_reference: reference,
  };
}

function referenceEntry(
  detailed: DetailedEntry,
  digester: PhaseContinuityPrivateDigester,
): ReferenceEntry {
  return {
    kind: "reference",
    source_ordinal: detailed.source_ordinal,
    unit_keyed_digest: keyedDigest(digester, "unit", JSON.stringify(detailed)),
    calls: detailed.calls.map((call) => ({
      tool_name: call.tool_name,
      result_ref: call.result_reference.identity.result_ref,
      result_sha256: call.result_reference.integrity.sha256,
    })),
  };
}

function downgradeToBound(
  ranges: ProjectionRange[],
  digester: PhaseContinuityPrivateDigester,
  serializedBytes: (messages: readonly ModelRoundMessage[]) => number,
): void {
  const ordered = ranges.flatMap((range) => range.entries.map((_, index) => ({ range, index })));
  let cursor = 0;
  while (projectionBytes(ranges, serializedBytes) > PHASE_CONTINUITY_PROJECTION_MAX_BYTES &&
      cursor < ordered.length) {
    const { range, index } = ordered[cursor++]!;
    const entry = range.entries[index]!;
    if (entry.kind === "detailed") range.entries[index] = referenceEntry(entry, digester);
  }
  if (projectionBytes(ranges, serializedBytes) > PHASE_CONTINUITY_PROJECTION_MAX_BYTES) {
    throw new PhaseContinuityProjectionError("phase_continuity_projection_too_large");
  }
}

function projectionBytes(
  ranges: readonly ProjectionRange[],
  serializedBytes: (messages: readonly ModelRoundMessage[]) => number,
): number {
  return statelessBytes(serializedBytes, ranges.map(syntheticMessage));
}

function syntheticMessage(range: ProjectionRange): ModelRoundMessage {
  const highest = range.units.at(-1)!.sourceOrdinal;
  return {
    role: "user",
    content: projectionJson(range.entries),
    requestSegmentKind: "phase_continuity",
    continuationItemId: `turn-item-${highest}`,
  };
}

function projectionJson(entries: readonly ProjectionEntry[]): string {
  return JSON.stringify({ schema: PHASE_CONTINUITY_PROJECTION_SCHEMA, entries });
}

function keyedDigest(
  digester: PhaseContinuityPrivateDigester,
  domain: "assistant_text" | "tool_arguments" | "unit",
  exactUtf8Bytes: string,
): string {
  let value: string;
  try {
    value = digester.digest(domain, exactUtf8Bytes);
  } catch (error) {
    throw new PhaseContinuityProjectionError(
      "phase_continuity_projection_private_digest_failed",
      { cause: error },
    );
  }
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new PhaseContinuityProjectionError(
      "phase_continuity_projection_keyed_digest_invalid",
    );
  }
  return value;
}

function statelessBytes(
  serializedBytes: (messages: readonly ModelRoundMessage[]) => number,
  messages: readonly ModelRoundMessage[],
): number {
  try {
    return serializedBytes(messages);
  } catch (error) {
    throw new PhaseContinuityProjectionError(
      "phase_continuity_projection_serializer_failed",
      { cause: error },
    );
  }
}
