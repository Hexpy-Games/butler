import { sanitizePublicText } from "../events/public-text.ts";

const OPENING_FIELD_MAX = 240;

export interface ParsedOpeningDecision {
  summary: string;
  rationale: string;
  nextStep: string;
}

export function parseOpeningDecisionText(value: unknown): ParsedOpeningDecision | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  if (!text.startsWith("{") || !text.endsWith("}")) return null;
  if (!hasExactlyOneRawOpeningKeySet(text)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (!hasExactOpeningDecisionKeys(parsed)) return null;
  const summary = safeOpeningField(parsed.summary);
  const rationale = safeOpeningField(parsed.rationale);
  const nextStep = safeOpeningField(parsed.nextStep);
  if (!summary || !rationale || !nextStep) return null;
  const decision = { summary, rationale, nextStep };
  if (!openingFieldsAreAllowed(decision)) return null;
  return decision;
}

function safeOpeningField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/gu, " ").trim();
  if (!text) return null;
  if (text.length > OPENING_FIELD_MAX) return null;
  if (sanitizePublicText(text, "") !== text) return null;
  return text;
}

function openingFieldsAreAllowed(decision: ParsedOpeningDecision): boolean {
  const joined = `${decision.summary} ${decision.rationale} ${decision.nextStep}`;
  return !looksLikeGenericFallback(joined) &&
    !claimsUnsupportedEvidence(joined) &&
    !containsHiddenReasoningLabel(joined) &&
    !containsRawPathLikeText(joined) &&
    !containsRawToolIdentifier(joined) &&
    !mentionsForbiddenOperationalInternals(joined);
}

function looksLikeGenericFallback(value: string): boolean {
  const normalized = normalizeComparableText(value);
  const exactFallbacks = [
    "working",
  ];
  const embeddedFallbacks = [
    "request received preparing the work",
    "request received preparing work",
    "preparing to work on this",
  ];
  return exactFallbacks.includes(normalized) ||
    embeddedFallbacks.some((phrase) => normalized.includes(phrase));
}

function claimsUnsupportedEvidence(value: string): boolean {
  const subject = String.raw`(?:evidence|files?|tests?|issues?|pull requests?|prs?|tickets?|repos?|repository|repository context|results?|sources?|commands?|ledgers?|diffs?|branches?|threads?|messages?|transcripts?|logs?|reports?|artifacts?)`;
  const pastClaimVerb = String.raw`(?:verified|validated|confirmed|found|read|checked|ran|created|saved|wrote|loaded|inspected|reviewed|examined|seen|saw|gathered|passed|pass|looked(?:\s+at)?|opened|searched|listed|evaluated)`;
  const completedEvidenceClaimVerb = String.raw`(?:read|reviewed|verified|validated|confirmed|examined|inspected|checked(?!\s+by\s+default\b))`;
  return new RegExp(String.raw`\b(?:already\s+)?${pastClaimVerb}\b.{0,120}\b${subject}\b`, "iu").test(value) ||
    new RegExp(String.raw`\b${subject}\b.{0,120}\b(?:(?:was|were|is|are|has been|have been)\s+)?(?:already\s+)?${pastClaimVerb}\b`, "iu").test(value) ||
    new RegExp(String.raw`\b(?:I|we|Butler)\s+(?:already\s+)?${pastClaimVerb}\b`, "iu").test(value) ||
    new RegExp(String.raw`\b(?:was|were|is|are|has been|have been|had been|got)\s+(?:already\s+)?${completedEvidenceClaimVerb}\b`, "iu").test(value);
}

function mentionsForbiddenOperationalInternals(value: string): boolean {
  const forbiddenPatterns = [
    /\b(?:bash|shell|read_file|write_file|apply_patch|update_todo_list)\b/iu,
    /\b(?:token|model)[-\s]+budgets?\b/iu,
    /\bmax\s*output\s*tokens?\b/iu,
    /\bmax[-\s]+output\b/iu,
    /\bprovider[-\s]+output[-\s]+caps?\b/iu,
    /\boutput[-\s]+tokens?[-\s]+caps?\b/iu,
    /\b(?:prompt\s+)?queue\b.{0,40}\b(?:empty|depth|length|state|item|items|entry|entries|internals?|payload|backlog|drain|drained|blocked)\b/iu,
    /\b(?:queue|queued)\b.{0,40}\b(?:prompt|prompts?|internal|internals?|state|payload)\b/iu,
    /\bprompt\b.{0,40}\b(?:queue|details?|payload|messages?|content|instructions?|state|context|internals?)\b/iu,
    /\bprompts?\b.{0,40}\b(?:prepared|preparing|built|building|assembled|assembling|generated|generating|loaded|loading|sent|sending|queued|queueing|processed|processing|constructed|constructing|hydrated|hydrating|rendered|rendering|compiled|compiling)\b/iu,
    /\bdiagnostics?\s+(?:output|logs?|traces?|data|context|mode|events?|reports?|details?|payload|state|internal|internals)\b/iu,
    /\brecovery\s+internals?\b/iu,
    /\brecovering_internal\b/iu,
    /\brecoverable\b/iu,
    /\bmodel\s+preparation\b/iu,
    /\btool\s+(?:names?|identifiers?|calls?|invocations?|payloads?)\b/iu,
  ];
  return forbiddenPatterns.some((pattern) => pattern.test(value));
}

function containsHiddenReasoningLabel(value: string): boolean {
  return /\b(?:analysis|reasoning|internal\s+plan|scratchpad)\s*(?::|[-\u2010-\u2015])/iu.test(value);
}

function containsRawPathLikeText(value: string): boolean {
  return /(?:^|[\s"'`(:=])(?:~\/|\.{1,2}\/|\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*|[A-Za-z]:\\|\\\\[^\s\\]+\\[^\s\\]+)/u.test(value) ||
    /(?:^|[\s"'`(:=])(?:[A-Za-z0-9._-]+\/){1,}[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,12}(?=$|[\s"'`).,;:!?])/u.test(value) ||
    /(?:^|[\s"'`(:=])(?:[A-Za-z0-9._-]+\/(?:apps?|bin|build|configs?|docs?|examples?|fixtures?|lib|packages|scripts?|src|test|tests))(?=$|[\s"'`).,;:!?])/u.test(value) ||
    /(?:^|[\s"'`(:=])(?:apps?|bin|build|configs?|docs?|examples?|fixtures?|lib|packages|scripts?|src|test|tests)\/[A-Za-z0-9._-]+(?=$|[\s"'`).,;:!?])/u.test(value) ||
    /(?:^|[\s"'`(:=])(?:[A-Za-z0-9._-]+\/){2,}[A-Za-z0-9._-]+(?=$|[\s"'`).,;:!?])/u.test(value);
}

function containsRawToolIdentifier(value: string): boolean {
  const rawToolPatterns = [
    /\bmcp__[a-z0-9_]+__[a-z0-9_]+\b/iu,
    /\b(?:run|read|write|edit|apply|update|list|search|open|fetch|exec|create|delete|view|click|type)_[a-z0-9_]+\b/iu,
    /\b(?:web|review|sync|project|ledger|tool|worker|agent|session|turn|runtime|gateway|model|provider|prompt|queue|memory|file|shell|bash|git|browser)_[a-z0-9_]+\b/iu,
    /\b[a-z][a-z0-9_]*_(?:tool|task|orchestration|command|search|browser|ledger|session|runtime|provider|prompt|queue|memory|gateway)\b/iu,
    /\b[a-z][a-z0-9]*__(?:[a-z0-9]+_?)+\b/iu,
  ];
  return rawToolPatterns.some((pattern) => pattern.test(value));
}

function hasExactOpeningDecisionKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === 3 &&
    keys[0] === "nextStep" &&
    keys[1] === "rationale" &&
    keys[2] === "summary";
}

function hasExactlyOneRawOpeningKeySet(text: string): boolean {
  const keys = scanTopLevelJsonObjectKeys(text);
  if (!keys) return false;
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts.size === 3 &&
    counts.get("summary") === 1 &&
    counts.get("rationale") === 1 &&
    counts.get("nextStep") === 1;
}

function scanTopLevelJsonObjectKeys(text: string): string[] | null {
  const keys: string[] = [];
  let index = 0;
  index = skipJsonWhitespace(text, index);
  if (text[index] !== "{") return null;
  index += 1;
  index = skipJsonWhitespace(text, index);
  if (text[index] === "}") {
    index += 1;
    return skipJsonWhitespace(text, index) === text.length ? keys : null;
  }
  while (index < text.length) {
    if (text[index] !== "\"") return null;
    const key = readJsonString(text, index);
    if (!key) return null;
    keys.push(key.value);
    index = skipJsonWhitespace(text, key.nextIndex);
    if (text[index] !== ":") return null;
    const valueEnd = skipJsonValue(text, index + 1);
    if (valueEnd === null) return null;
    index = skipJsonWhitespace(text, valueEnd);
    if (text[index] === ",") {
      index += 1;
      index = skipJsonWhitespace(text, index);
      continue;
    }
    if (text[index] === "}") {
      index += 1;
      return skipJsonWhitespace(text, index) === text.length ? keys : null;
    }
    return null;
  }
  return null;
}

function skipJsonValue(text: string, startIndex: number): number | null {
  const index = skipJsonWhitespace(text, startIndex);
  const initial = text[index];
  if (initial === "\"") return readJsonString(text, index)?.nextIndex ?? null;
  if (initial === "{" || initial === "[") return skipJsonContainer(text, index);
  if (initial === "-" || (initial >= "0" && initial <= "9")) {
    return skipJsonNumber(text, index);
  }
  for (const literal of ["true", "false", "null"]) {
    if (text.startsWith(literal, index)) return index + literal.length;
  }
  return null;
}

function skipJsonContainer(text: string, startIndex: number): number | null {
  const opener = text[startIndex];
  const closer = opener === "{" ? "}" : "]";
  const stack = [closer];
  let index = startIndex + 1;
  while (index < text.length && stack.length > 0) {
    const char = text[index];
    if (char === "\"") {
      const string = readJsonString(text, index);
      if (!string) return null;
      index = string.nextIndex;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
      index += 1;
      continue;
    }
    if (char === stack.at(-1)) {
      stack.pop();
      index += 1;
      continue;
    }
    index += 1;
  }
  return stack.length === 0 ? index : null;
}

function readJsonString(text: string, startIndex: number): { value: string; nextIndex: number } | null {
  let value = "";
  let index = startIndex + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === "\"") return { value, nextIndex: index + 1 };
    if (char === "\\") {
      const escaped = text[index + 1];
      if (!escaped) return null;
      if (escaped === "u") {
        const hex = text.slice(index + 2, index + 6);
        if (!/^[0-9a-f]{4}$/iu.test(hex)) return null;
        value += String.fromCodePoint(Number.parseInt(hex, 16));
        index += 6;
        continue;
      }
      value += escaped;
      index += 2;
      continue;
    }
    value += char;
    index += 1;
  }
  return null;
}

function skipJsonNumber(text: string, startIndex: number): number | null {
  const match = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(text.slice(startIndex));
  return match?.index === 0 ? startIndex + match[0].length : null;
}

function skipJsonWhitespace(text: string, startIndex: number): number {
  let index = startIndex;
  while (index < text.length && /\s/u.test(text[index] ?? "")) index += 1;
  return index;
}

function normalizeComparableText(value: string): string {
  return value
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
