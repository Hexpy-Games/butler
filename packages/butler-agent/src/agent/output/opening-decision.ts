import { createHash } from "node:crypto";
import { createTurnDecisionPayload } from "../events/turn-state-contract.ts";
import {
  parseOpeningDecisionText,
  type ParsedOpeningDecision,
} from "./opening-decision-policy.ts";
import type {
  ModelInvocation,
  ModelProviderAdapter,
  ModelRef,
} from "../../test-support/harness/contracts.ts";

const OPENING_INPUT_MAX = 1_200;
const OPENING_REF_MAX = 8;
const OPENING_REF_TEXT_MAX = 160;
const OPENING_DEFAULT_TIMEOUT_MS = 2_000;

export interface OpeningDecisionInput {
  userMessage: string;
  model: ModelRef;
  sessionRole?: string;
  projectId?: string;
  locale?: string;
  languageHint?: string;
  latestStableDecisionRef?: string;
  unresolvedObservationRefs?: string[];
  continuationRefs?: string[];
  evidenceRefs?: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  now?: () => number;
}

export interface OpeningDecisionPayload {
  decisionId: string;
  role: "opening";
  source: "model-authored";
  firstVisible: true;
  summary: string;
  rationale: string;
  nextStep: string;
  modelCallId?: string;
  latencyMs: number;
}

export { parseOpeningDecisionText } from "./opening-decision-policy.ts";

export async function generateOpeningDecisionWithProvider(
  provider: ModelProviderAdapter,
  input: OpeningDecisionInput,
): Promise<OpeningDecisionPayload | null> {
  const boundedMessage = boundedInputText(input.userMessage);
  if (!boundedMessage || input.signal?.aborted) return null;
  const timeoutMs = input.timeoutMs ?? OPENING_DEFAULT_TIMEOUT_MS;
  const now = input.now ?? Date.now;
  const startedAt = now();
  const controller = new AbortController();
  const stopForwardingAbort = forwardAbortSignal(input.signal, controller);
  try {
    const invocation: ModelInvocation = {
      model: input.model,
      reasoning: { effort: "low" },
      toolChoice: "none",
      signal: controller.signal,
      systemPrompt: openingDecisionSystemPrompt(),
      messages: [{
        role: "user",
        content: openingDecisionUserPrompt(input, boundedMessage),
      }],
      metadata: {
        purpose: "app_opening_decision",
      },
    };
    const result = await withTimeout(
      provider.invoke(invocation),
      timeoutMs,
      controller,
    );
    if (input.signal?.aborted) return null;
    const parsed = parseOpeningDecisionText(result.text);
    if (!parsed) return null;
    const payload = createTurnDecisionPayload({
      decisionId: stableOpeningDecisionId(input, parsed),
      role: "opening",
      summary: parsed.summary,
      rationale: parsed.rationale,
      nextStep: parsed.nextStep,
      source: "model-authored",
      firstVisible: true,
      evidenceRefs: input.evidenceRefs,
    });
    return {
      decisionId: String(payload.decisionId),
      role: "opening",
      source: "model-authored",
      firstVisible: true,
      summary: String(payload.summary),
      rationale: String(payload.rationale),
      nextStep: String(payload.nextStep),
      ...optionalModelCallId(result.raw),
      latencyMs: Math.max(0, Math.round(now() - startedAt)),
    };
  } catch {
    return null;
  } finally {
    stopForwardingAbort();
  }
}

function openingDecisionSystemPrompt(): string {
  return [
    "Generate the first public opening decision for Butler.",
    "Return only JSON with exactly these string fields: summary, rationale, nextStep.",
    "Use the user's language when clear.",
    "No markdown, no prose outside JSON, no tools, no hidden reasoning.",
    "Be brief: each field must be one compact sentence and should stay under 24 words.",
    "Do not claim files, repos, tests, ledgers, evidence, commands, or sources were read, checked, reviewed, passed, verified, found, loaded, inspected, gathered, or examined.",
    "Do not mention raw paths, tool names, token budgets, model budget, recovery internals, queues, prompts, or diagnostic internals.",
  ].join(" ");
}

function openingDecisionUserPrompt(input: OpeningDecisionInput, boundedMessage: string): string {
  return JSON.stringify({
    userMessage: boundedMessage,
    sessionRole: boundedOptionalText(input.sessionRole),
    projectId: boundedOptionalText(input.projectId),
    locale: boundedOptionalText(input.locale),
    languageHint: boundedOptionalText(input.languageHint),
    latestStableDecisionRef: boundedOptionalText(input.latestStableDecisionRef),
    unresolvedObservationRefs: boundedRefs(input.unresolvedObservationRefs),
    continuationRefs: boundedRefs(input.continuationRefs),
    evidenceRefs: boundedRefs(input.evidenceRefs),
  });
}

function boundedInputText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/gu, " ").trim();
  return text ? text.slice(0, OPENING_INPUT_MAX) : null;
}

function boundedOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/gu, " ").trim();
  return text ? text.slice(0, OPENING_REF_TEXT_MAX) : undefined;
}

function boundedRefs(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const refs = value
    .map((item) => boundedOptionalText(item))
    .filter((item): item is string => Boolean(item))
    .slice(0, OPENING_REF_MAX);
  return refs.length > 0 ? refs : undefined;
}

function stableOpeningDecisionId(
  input: OpeningDecisionInput,
  decision: ParsedOpeningDecision,
): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({
    userMessage: boundedInputText(input.userMessage),
    sessionRole: boundedOptionalText(input.sessionRole),
    projectId: boundedOptionalText(input.projectId),
    locale: boundedOptionalText(input.locale),
    languageHint: boundedOptionalText(input.languageHint),
    latestStableDecisionRef: boundedOptionalText(input.latestStableDecisionRef),
    unresolvedObservationRefs: boundedRefs(input.unresolvedObservationRefs) ?? [],
    continuationRefs: boundedRefs(input.continuationRefs) ?? [],
    evidenceRefs: boundedRefs(input.evidenceRefs) ?? [],
    summary: decision.summary,
    rationale: decision.rationale,
    nextStep: decision.nextStep,
  }));
  return `opening-${hash.digest("hex").slice(0, 24)}`;
}

function optionalModelCallId(raw: unknown): { modelCallId?: string } {
  if (!isRecord(raw)) return {};
  const value = raw.modelCallId ?? raw.model_call_id ?? raw.id;
  const text = boundedOptionalText(value);
  return text ? { modelCallId: text } : {};
}

function forwardAbortSignal(
  source: AbortSignal | undefined,
  controller: AbortController,
): () => void {
  if (!source) return () => {};
  if (source.aborted) {
    controller.abort(source.reason);
    return () => {};
  }
  const onAbort = () => controller.abort(source.reason);
  source.addEventListener("abort", onAbort, { once: true });
  return () => source.removeEventListener("abort", onAbort);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  controller: AbortController,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopListeningForAbort: (() => void) | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error("opening decision timeout"));
      reject(new Error("opening decision timeout"));
    }, Math.max(0, timeoutMs));
  });
  const abortPromise = new Promise<never>((_, reject) => {
    const onAbort = () => {
      controller.signal.removeEventListener("abort", onAbort);
      reject(new Error("opening decision aborted"));
    };
    if (controller.signal.aborted) {
      reject(new Error("opening decision aborted"));
      return;
    }
    controller.signal.addEventListener("abort", onAbort, { once: true });
    stopListeningForAbort = () => controller.signal.removeEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([promise, timeoutPromise, abortPromise]);
  } finally {
    if (timer) clearTimeout(timer);
    stopListeningForAbort?.();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
