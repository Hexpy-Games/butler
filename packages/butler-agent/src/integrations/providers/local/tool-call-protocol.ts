import { LOCAL_TEXT_TOOL_CALL_CLOSE_MARKERS, LOCAL_TEXT_TOOL_CALL_OPEN_MARKERS, localAssistantRawText, type LocalChatToolCall, MAX_LOCAL_TEXT_TOOL_ARGUMENTS_LENGTH, MAX_LOCAL_TEXT_TOOL_CALL_BODY_LENGTH, MAX_LOCAL_TEXT_TOOL_CALLS, MAX_LOCAL_TEXT_TOOL_SCAN_LENGTH } from "./text-protocol.ts";
import { localToolArguments, normalizeLocalTextToolName } from "../shared/runtime-support.ts";




export function parseJsonObjectOrNull(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}




export function parseLocalJsonishObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_LOCAL_TEXT_TOOL_ARGUMENTS_LENGTH) return null;
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  const strict = parseJsonObjectOrNull(trimmed);
  if (strict) return strict;
  const normalized = trimmed
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)\s*:/gu, "$1\"$2\":")
    .replace(/,\s*([}\]])/gu, "$1");
  return parseJsonObjectOrNull(normalized);
}




export function localTextToolArguments(raw: string): {
  parsed: Record<string, unknown>;
  raw: string;
} | null {
  const trimmed = raw.trim();
  if (!trimmed) return { parsed: {}, raw: "{}" };
  const argsStart = trimmed.indexOf("{");
  const argsEnd = trimmed.lastIndexOf("}");
  if (argsStart < 0 || argsEnd < argsStart) return null;
  const objectText = trimmed.slice(argsStart, argsEnd + 1);
  const parsed = parseLocalJsonishObject(objectText);
  if (!parsed) return null;
  return {
    parsed,
    raw: JSON.stringify(parsed),
  };
}




export function parseLocalTextToolCallBody(
  body: string,
  allowedNames: Set<string> | undefined,
  index: number,
): LocalChatToolCall | null {
  const trimmed = body.trim();
  if (!trimmed || trimmed.length > MAX_LOCAL_TEXT_TOOL_CALL_BODY_LENGTH) return null;

  const callMatch = trimmed.match(/^call\s*:\s*([A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)*)\s*([\s\S]*)$/iu);
  if (callMatch) {
    const name = normalizeLocalTextToolName(callMatch[1] ?? "", allowedNames ?? new Set<string>());
    if (!name || (allowedNames && allowedNames.size > 0 && !allowedNames.has(name))) return null;
    const args = localTextToolArguments(callMatch[2] ?? "");
    if (!args) return null;
    return {
      id: `local_text_call_${index}`,
      type: "function",
      origin: "text",
      function: {
        name,
        arguments: args.raw,
      },
    };
  }

  const parsed = parseLocalJsonishObject(trimmed);
  if (!parsed) return null;
  const functionRecord = parsed.function && typeof parsed.function === "object" && !Array.isArray(parsed.function)
    ? parsed.function as Record<string, unknown>
    : null;
  const rawName = [
    parsed.name,
    parsed.tool_name,
    parsed.tool,
    parsed.function,
    functionRecord?.name,
  ].find((value): value is string => typeof value === "string");
  if (!rawName) return null;
  const name = normalizeLocalTextToolName(rawName, allowedNames ?? new Set<string>());
  if (!name || (allowedNames && allowedNames.size > 0 && !allowedNames.has(name))) return null;
  const rawArguments = parsed.arguments ?? parsed.args ?? parsed.parameters ??
    functionRecord?.arguments ?? functionRecord?.args ?? functionRecord?.parameters ?? {};
  const args = localToolArguments(rawArguments);
  return {
    id: `local_text_call_${index}`,
    type: "function",
    origin: "text",
    function: {
      name,
      arguments: args.raw,
    },
  };
}




export function findFirstLocalTextToolCallMarker(
  text: string,
  markers: string[],
  start: number,
): { index: number; marker: string } | null {
  let best: { index: number; marker: string } | null = null;
  for (const marker of markers) {
    const index = text.indexOf(marker, start);
    if (index < 0) continue;
    if (!best || index < best.index) {
      best = { index, marker };
    }
  }
  return best;
}




export function extractLocalTextToolCallBodies(text: string): string[] {
  if (text.length > MAX_LOCAL_TEXT_TOOL_SCAN_LENGTH) return [];
  const bodies: string[] = [];
  let cursor = 0;
  while (cursor < text.length && bodies.length < MAX_LOCAL_TEXT_TOOL_CALLS) {
    const open = findFirstLocalTextToolCallMarker(text, LOCAL_TEXT_TOOL_CALL_OPEN_MARKERS, cursor);
    if (!open) break;
    const bodyStart = open.index + open.marker.length;
    const close = findFirstLocalTextToolCallMarker(text, LOCAL_TEXT_TOOL_CALL_CLOSE_MARKERS, bodyStart);
    if (!close) break;
    bodies.push(text.slice(bodyStart, close.index));
    cursor = close.index + close.marker.length;
  }
  return bodies;
}




export function extractLocalTextToolCalls(text: string, allowedNames?: Set<string>): LocalChatToolCall[] {
  const calls: LocalChatToolCall[] = [];
  for (const body of extractLocalTextToolCallBodies(text)) {
    const call = parseLocalTextToolCallBody(body, allowedNames, calls.length + 1);
    if (call) calls.push(call);
  }
  return calls;
}




export function extractLocalToolCalls(message: any, allowedNames?: Set<string>): LocalChatToolCall[] {
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  const structuredCalls = calls.flatMap((call: any): LocalChatToolCall[] => {
    const name = normalizeLocalTextToolName(
      typeof call?.function?.name === "string" ? call.function.name : "",
      allowedNames ?? new Set<string>(),
    );
    if (
      !call ||
      typeof call !== "object" ||
      typeof call.id !== "string" ||
      !call.function ||
      typeof call.function !== "object" ||
      !name
    ) {
      return [];
    }
    return [{
      ...call,
      origin: "native",
      function: {
        ...call.function,
        name,
      },
    }];
  });
  if (calls.length > 0) return structuredCalls;
  return extractLocalTextToolCalls(localAssistantRawText(message), allowedNames);
}
