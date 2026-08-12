import type {
  M1ProviderRequestSegmentManifestEntry,
  M1RequestSegmentKind,
  M1RequestSegmentSource,
} from "../../../agent/btcc/ports/provider-request-attribution.ts";

export interface OpenAIRequestSegmentContinuation {
  provider: "openai";
  responseId: string;
  sent: { toolMessages: number; userMessages: number };
  statelessInput: Array<Record<string, unknown>>;
  statelessManifest: M1ProviderRequestSegmentManifestEntry[];
}

export function isOpenAIRequestSegmentContinuation(
  value: unknown,
): value is OpenAIRequestSegmentContinuation {
  return Boolean(
    value && typeof value === "object" &&
    (value as Record<string, unknown>).provider === "openai" &&
    typeof (value as Record<string, unknown>).responseId === "string",
  );
}

export function buildOpenAIRequestSegmentManifests(input: {
  instructions?: string;
  instructionSources?: readonly M1RequestSegmentSource[];
  officialInput: unknown;
  codexAppendedInput: unknown;
  appendedItemKinds?: readonly (M1RequestSegmentKind | undefined)[];
  codexAppendedItemKinds?: readonly (M1RequestSegmentKind | undefined)[];
  promptSources?: readonly M1RequestSegmentSource[];
  previousCodexInput?: readonly Record<string, unknown>[];
  previousCodexManifest?: readonly M1ProviderRequestSegmentManifestEntry[];
}): {
  official: M1ProviderRequestSegmentManifestEntry[];
  codex: M1ProviderRequestSegmentManifestEntry[];
  continuation: M1ProviderRequestSegmentManifestEntry[];
} {
  const instruction = instructionManifest(input.instructions, input.instructionSources);
  const officialInput = input.appendedItemKinds
    ? itemManifest(input.officialInput, input.appendedItemKinds, 0)
    : initialInputManifest(input.officialInput, input.promptSources);
  const previous = input.previousCodexInput
    ? olderReplayManifest(input.previousCodexInput, input.previousCodexManifest ?? [])
    : [];
  const appended = input.codexAppendedItemKinds
    ? itemManifest(input.codexAppendedInput, input.codexAppendedItemKinds, 0)
    : input.previousCodexInput
    ? itemManifest(
        input.codexAppendedInput,
        input.appendedItemKinds ?? [],
        input.previousCodexInput.length,
      )
    : initialInputManifest(input.codexAppendedInput, input.promptSources);
  const continuation = [...previous, ...appended];
  return {
    official: [...instruction, ...officialInput],
    codex: [...instruction, ...continuation],
    continuation,
  };
}

/**
 * Codex OAuth replays provider-produced function calls in the next stateless
 * request so their matching outputs retain protocol continuity. These exact
 * fields are neither Butler tool results nor provider-owned JSON structure:
 * they are dynamic phase continuity authored by the preceding model response.
 */
export function appendOpenAIFunctionCallContinuityManifest(
  manifest: readonly M1ProviderRequestSegmentManifestEntry[],
  functionCalls: readonly Record<string, unknown>[],
  indexOffset: number,
): M1ProviderRequestSegmentManifestEntry[] {
  const continuity = functionCalls.flatMap((item, localIndex) =>
    (["name", "arguments"] as const).flatMap((field) =>
      typeof item[field] === "string"
        ? [{
            path: ["input", indexOffset + localIndex, field],
            kind: "phase_continuity" as const,
            stability: "dynamic" as const,
          }]
        : [],
    ),
  );
  return [...manifest, ...continuity];
}

function instructionManifest(
  instructions: string | undefined,
  sources: readonly M1RequestSegmentSource[] | undefined,
): M1ProviderRequestSegmentManifestEntry[] {
  if (typeof instructions !== "string") return [];
  return textManifest(
    ["instructions"], instructions, sources, "stable_btcc_protocol", "stable",
  );
}

function initialInputManifest(
  input: unknown,
  sources: readonly M1RequestSegmentSource[] | undefined,
): M1ProviderRequestSegmentManifestEntry[] {
  const path = primaryInputTextPath(input);
  if (!path) return [];
  const value = valueAtPath({ input }, path);
  return typeof value === "string"
    ? textManifest(path, value, sources, "other_typed_context")
    : [];
}

function itemManifest(
  input: unknown,
  kinds: readonly (M1RequestSegmentKind | undefined)[],
  indexOffset: number,
): M1ProviderRequestSegmentManifestEntry[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((item, localIndex) => {
    const index = indexOffset + localIndex;
    const kind = kinds[localIndex] ?? "other_typed_context";
    return stringPayloadPaths(item).map((suffix) => ({
      path: ["input", index, ...suffix], kind, stability: "dynamic" as const,
    }));
  });
}

function olderReplayManifest(
  input: readonly Record<string, unknown>[],
  manifest: readonly M1ProviderRequestSegmentManifestEntry[],
): M1ProviderRequestSegmentManifestEntry[] {
  const olderIndexes = new Set(input.flatMap((item, index) =>
    item.type === "function_call_output" ? [index] : [],
  ));
  return manifest.map((entry) =>
    entry.path[0] === "input" && typeof entry.path[1] === "number" &&
      olderIndexes.has(entry.path[1])
      ? { ...entry, kind: "older_tool_result_projection" }
      : entry,
  );
}

function textManifest(
  path: readonly (string | number)[],
  value: string,
  sources: readonly M1RequestSegmentSource[] | undefined,
  fallbackKind: M1RequestSegmentKind,
  fallbackStability: "stable" | "dynamic" = "dynamic",
): M1ProviderRequestSegmentManifestEntry[] {
  if (!sources?.length || sources.map((source) => source.text).join("") !== value) {
    return [{ path, kind: fallbackKind, stability: fallbackStability }];
  }
  let cursor = 0;
  return sources.map((source) => {
    const startUtf16 = cursor;
    cursor += source.text.length;
    return { path, kind: source.kind, stability: source.stability, startUtf16, endUtf16: cursor };
  });
}

function primaryInputTextPath(input: unknown): readonly (string | number)[] | undefined {
  if (typeof input === "string") return ["input"];
  if (Array.isArray(input) && typeof input[0] === "object" && input[0]) {
    const item = input[0] as Record<string, unknown>;
    if (Array.isArray(item.content) && typeof item.content[0] === "object" && item.content[0]) {
      return ["input", 0, "content", 0, "text"];
    }
  }
  return undefined;
}

function stringPayloadPaths(item: unknown): Array<readonly (string | number)[]> {
  if (!item || typeof item !== "object") return [];
  const record = item as Record<string, unknown>;
  if (record.type === "function_call") {
    return ["name", "arguments"].flatMap((field) =>
      typeof record[field] === "string" ? [[field] as const] : [],
    );
  }
  if (typeof record.output === "string") return [["output"]];
  if (Array.isArray(record.output)) return record.output.flatMap((part, index) =>
    part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string"
      ? [["output", index, "text"] as const]
      : [],
  );
  if (Array.isArray(record.content)) return record.content.flatMap((part, index) =>
    part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string"
      ? [["content", index, "text"] as const]
      : [],
  );
  return [];
}

function valueAtPath(root: unknown, path: readonly (string | number)[]): unknown {
  let value = root;
  for (const part of path) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<string | number, unknown>)[part];
  }
  return value;
}
