import type { RuntimeTurnInput } from "../../test-support/harness/contracts.ts";
import type { RuntimeMessageLanguage } from "../output/messages.ts";
import type { ToolAuditEntry } from "../turn/native/output/tool-types.ts";

export interface RuntimeIntentGuardDecision {
  text: string;
  guard: "none" | "correction_challenge" | "short_utterance_correction" | "short_cue_rhythm";
  detail?: string;
}

export type RuntimeIntentGuardName = Exclude<RuntimeIntentGuardDecision["guard"], "none"> | "context_sufficiency";

export function shouldEnforceGrounding(input: RuntimeTurnInput): boolean {
  if ("text" in input.input) return true;
  return input.input.transport !== "system";
}

function metadataRecords(metadata: unknown): Record<string, unknown>[] {
  const values = Array.isArray(metadata) ? metadata : [metadata];
  return values
    .filter((value): value is Record<string, unknown> =>
      Boolean(value) && typeof value === "object" && !Array.isArray(value),
    );
}

export function requiredExplicitToolNames(metadata: unknown, availableToolNames: string[]): string[] {
  const available = new Set(availableToolNames);
  const values = metadataRecords(metadata).flatMap((record) => {
    const runtimePolicy = record.runtimePolicy && typeof record.runtimePolicy === "object"
      ? record.runtimePolicy as Record<string, unknown>
      : {};
    const raw = record.requiredNativeTools ?? record.required_tools ?? runtimePolicy.requiredNativeTools ??
      runtimePolicy.required_tools;
    return Array.isArray(raw) ? raw : [];
  });
  return [...new Set(values
    .filter((value): value is string => typeof value === "string" && available.has(value)))]
    .slice(0, 6);
}

export function explicitToolRequirementRepairPrompt(input: {
  prompt: string;
  previousAnswer: string;
  missingTools: string[];
}): string {
  return [
    "## Explicit Tool Requirement Repair",
    "The caller supplied structured required native tools that have not all succeeded yet.",
    "Missing required tools: " + input.missingTools.map((tool) => "`" + tool + "`").join(", "),
    "Continue the same task, but call only the missing required tools now unless a missing tool itself returns an error requiring another evidence tool.",
    "Do not produce the final answer until the missing required tools succeed or return a clear tool error.",
    "For every tool call, write a public work decision with exact protocol keys: `summary:`, `rationale:`, and `next_step:`.",
    "After the missing tools succeed, synthesize only the outcome. Do not list raw tool logs.",
    "",
    "Original request:",
    input.prompt,
    "",
    "Previous incomplete answer:",
    input.previousAnswer.trim(),
  ].join("\n");
}

export function applyCorrectionChallengeGuard(input: {
  userText: string;
  responseText: string;
  audit: ToolAuditEntry[];
  language?: RuntimeMessageLanguage;
}): string {
  return input.responseText;
}

export function applyShortUtteranceCorrectionGuard(input: {
  userText: string;
  responseText: string;
  language?: RuntimeMessageLanguage;
}): string {
  return input.responseText;
}

export function applyShortCueRhythmGuard(input: {
  userText: string;
  responseText: string;
  language?: RuntimeMessageLanguage;
}): string {
  return input.responseText;
}

export function applyRuntimeIntentGuardsWithDecision(input: {
  userText: string;
  responseText: string;
  audit: ToolAuditEntry[];
  language: RuntimeMessageLanguage;
}): RuntimeIntentGuardDecision {
  return { text: input.responseText, guard: "none" };
}

function hasNonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function toolResultObject(result: unknown): Record<string, unknown> {
  return result && typeof result === "object" ? result as Record<string, unknown> : {};
}

function hasUsableWebSearchEvidence(entry: ToolAuditEntry): boolean {
  const result = toolResultObject(entry.result);
  if (result.ok === false) return false;
  return hasNonEmptyArray(result.results) || hasNonEmptyArray(result.source_urls);
}

function hasUsableWebReadEvidence(entry: ToolAuditEntry): boolean {
  const result = toolResultObject(entry.result);
  if (result.ok === false) return false;
  if (hasNonEmptyArray(result.chunks)) return true;
  if (typeof result.markdown === "string" && result.markdown.trim().length > 0) return true;
  return typeof result.text === "string" && result.text.trim().length > 0;
}

function isSuccessfulToolEntry(entry: ToolAuditEntry): boolean {
  if (!entry.ok) return false;
  if (entry.name === "web_search") return hasUsableWebSearchEvidence(entry);
  if (entry.name === "web_read") return hasUsableWebReadEvidence(entry);
  return true;
}

export function hasSuccessfulTool(audit: ToolAuditEntry[], names: string[]): boolean {
  return audit.some((entry) => names.includes(entry.name) && isSuccessfulToolEntry(entry));
}

export function sourceUrlsFromWebSearchAudit(audit: ToolAuditEntry[]): string[] {
  const urls: string[] = [];
  for (const entry of audit) {
    if (!entry.ok || (entry.name !== "web_search" && entry.name !== "web_read")) continue;
    const result = entry.result as { source_urls?: unknown; results?: unknown } | undefined;
    if (entry.name === "web_search" && Array.isArray(result?.source_urls)) {
      urls.push(...result.source_urls.filter((url): url is string => typeof url === "string" && url.trim().length > 0));
    }
    if (entry.name === "web_search" && Array.isArray(result?.results)) {
      for (const item of result.results) {
        if (item && typeof item === "object" && typeof (item as { url?: unknown }).url === "string") {
          urls.push((item as { url: string }).url);
        }
      }
    }
    const readResult = entry.result as { source_url?: unknown; final_url?: unknown } | undefined;
    for (const value of [readResult?.source_url, readResult?.final_url]) {
      if (typeof value === "string" && value.trim()) urls.push(value.trim());
    }
  }
  return [...new Set(urls)];
}

export function renderSearchEvidenceForRepair(audit: ToolAuditEntry[]): string {
  const urls = sourceUrlsFromWebSearchAudit(audit).slice(0, 5);
  if (urls.length === 0) return "No source URLs were returned by search.";
  return [
    "Returned source URLs:",
    ...urls.map((url) => `- ${url}`),
  ].join("\n");
}

export function applyWebSearchCitationGuard(input: {
  text: string;
  audit: ToolAuditEntry[];
}): string {
  const urls = sourceUrlsFromWebSearchAudit(input.audit);
  if (urls.length === 0) return input.text;
  if (urls.some((url) => input.text.includes(url))) return input.text;
  return [
    input.text.trim(),
    "",
    "Sources:",
    ...urls.slice(0, 3).map((url) => `- [${url}](${url})`),
  ].join("\n");
}

export function enforceGroundedActionClaims(input: {
  userText: string;
  responseText: string;
  audit: ToolAuditEntry[];
  language?: RuntimeMessageLanguage;
}): string {
  return input.responseText;
}
