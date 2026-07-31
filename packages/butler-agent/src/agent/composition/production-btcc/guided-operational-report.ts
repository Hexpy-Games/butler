import type { GuidedEffectJournalRecord } from "../../btcc/effects/index.ts";
import type {
  DurableWorkContext,
  DurableWorkView,
} from "../../btcc/durable-work/index.ts";
import type { GuidedToolJournalRecord } from "../../adapters/index.ts";
import type { FunctionToolPromptOptions } from
  "../../../integrations/providers/runtime-contracts.ts";

export const DEFAULT_GUIDED_TURN_LEASE_MS = 300_000;
export const DEFAULT_GUIDED_FINAL_REPORT_MS = 30_000;

const FACT_LIMIT = 12;
const FACT_VALUE_LIMIT = 480;

type PromptRunner = (options: FunctionToolPromptOptions) => Promise<string>;

export async function runGuidedPromptWithOperationalReport(input: {
  promptRunner: PromptRunner;
  options: FunctionToolPromptOptions;
  parentSignal: AbortSignal;
  leaseStartedAt: number;
  leaseMs?: number;
  finalReportMs?: number;
  loadFacts: () => Promise<Omit<OperationalFacts, "assistantDraft">>;
}): Promise<string> {
  const leaseMs = positiveMs(input.leaseMs, DEFAULT_GUIDED_TURN_LEASE_MS);
  const finalReportMs = Math.min(
    positiveMs(input.finalReportMs, DEFAULT_GUIDED_FINAL_REPORT_MS),
    Math.max(1, leaseMs - 1),
  );
  const mainDeadline = input.leaseStartedAt + leaseMs - finalReportMs;
  let assistantDraft = "";
  try {
    const text = await runInGuidedOperationalWindow({
      parentSignal: input.parentSignal,
      timeoutMs: Math.max(1, mainDeadline - Date.now()),
      run: (signal) => input.promptRunner({
        ...input.options,
        signal,
        executeTool: (call) => input.options.executeTool({
          ...call,
          signal: call.signal ?? signal,
        }),
        async onAssistantTextBeforeTools(candidate) {
          if (candidate.text.trim()) assistantDraft = candidate.text.trim();
          await input.options.onAssistantTextBeforeTools?.(candidate);
        },
      }),
    });
    if (!text.trim()) throw new Error("Guided model returned no final text");
    return text;
  } catch (error) {
    if (input.parentSignal.aborted) throw error;
  }

  const facts = { ...await input.loadFacts(), assistantDraft };
  const remainingMs = input.leaseStartedAt + leaseMs - Date.now();
  if (remainingMs > 0) {
    try {
      const text = await runInGuidedOperationalWindow({
        parentSignal: input.parentSignal,
        timeoutMs: Math.min(finalReportMs, remainingMs),
        run: (signal) => input.promptRunner({
          ...input.options,
          prompt: guidedOperationalReportPrompt(facts),
          instructions: "Report only the supplied current facts. Do not call tools.",
          signal,
          attachments: [],
          tools: [],
          maxToolRounds: 1,
          providerRetryAttempts: 0,
          executeTool: rejectOperationalToolCall,
          onAssistantTextBeforeTools: undefined,
        }),
      });
      if (text.trim()) return text;
    } catch (error) {
      if (input.parentSignal.aborted) throw error;
    }
  }
  return guidedOperationalFallback(facts);
}

export class GuidedOperationalWindowExpired extends Error {
  constructor() {
    super("Guided Turn operational window expired");
    this.name = "GuidedOperationalWindowExpired";
  }
}

export async function runInGuidedOperationalWindow<T>(input: {
  parentSignal: AbortSignal;
  timeoutMs: number;
  run: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  throwIfAborted(input.parentSignal);
  const controller = new AbortController();
  const expire = () => controller.abort(new GuidedOperationalWindowExpired());
  const cancel = () => controller.abort(input.parentSignal.reason);
  input.parentSignal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(expire, Math.max(1, Math.trunc(input.timeoutMs)));
  let rejectWindow!: (error: Error) => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectWindow = reject;
  });
  const rejectOnAbort = () => {
    rejectWindow(controller.signal.reason instanceof Error
      ? controller.signal.reason
      : new Error("Guided Turn was aborted"));
  };
  controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
  try {
    return await Promise.race([input.run(controller.signal), interrupted]);
  } finally {
    clearTimeout(timer);
    input.parentSignal.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", rejectOnAbort);
  }
}

export function guidedOperationalReportPrompt(input: OperationalFacts): string {
  return [
    "The normal execution window ended before a final answer was available.",
    "Give the user one concise, truthful answer using only the facts below.",
    "Clearly separate what completed, what remains, and any limitation.",
    "Do not claim that an unlisted action or effect happened. Do not call tools.",
    "",
    `Original request: ${input.originalRequest}`,
    ...factLines(input),
    ...preservedDraftLines(input),
  ].join("\n");
}

export function guidedOperationalFallback(input: OperationalFacts): string {
  const korean = /[가-힣]/.test(input.originalRequest);
  const facts = factLines(input).filter((line) => line.startsWith("- "));
  if (korean) {
    return [
      "요청을 끝까지 정리하는 과정에서 모델 연결 또는 실행 시간이 종료되었습니다.",
      ...preservedDraftFallback(input, true),
      facts.length > 0 ? "현재까지 확인되어 저장된 내용:" : "실행이 확인된 도구나 변경은 없습니다.",
      ...facts,
      "완료되지 않은 부분은 완료되었다고 처리하지 않았으며, 저장된 작업 기록에서 이어갈 수 있습니다.",
    ].join("\n");
  }
  return [
    "The model connection or execution window ended before I could finish the answer.",
    ...preservedDraftFallback(input, false),
    facts.length > 0 ? "Confirmed and saved so far:" : "No tool action or change was confirmed.",
    ...facts,
    "I did not mark the unfinished part complete; the saved Work can be continued.",
  ].join("\n");
}

export type OperationalFacts = {
  originalRequest: string;
  assistantDraft?: string;
  work: DurableWorkContext | DurableWorkView | null;
  toolCalls: GuidedToolJournalRecord[];
  effects: GuidedEffectJournalRecord[];
};

async function rejectOperationalToolCall(): Promise<never> {
  throw new Error("Operational final report cannot call tools");
}

function positiveMs(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value));
}

function factLines(input: OperationalFacts): string[] {
  const lines: string[] = ["Known durable facts:"];
  const work = input.work && "work" in input.work ? input.work.work : input.work;
  if (work) {
    lines.push(`- Work is ${work.status}: ${compact(work.objective)}`);
    if (work.latestCheckpoint) {
      lines.push(
        `- Latest progress (${work.latestCheckpoint.stage}): ${compact(work.latestCheckpoint.publicSummary)}`,
      );
      lines.push(`- Next recorded step: ${compact(work.latestCheckpoint.nextStep)}`);
    }
  }
  for (const call of input.toolCalls.slice(-FACT_LIMIT)) {
    const result = call.result === undefined ? "" : ` — ${compact(call.result)}`;
    lines.push(`- Tool ${call.toolName}: ${call.status}${result}`);
  }
  for (const effect of input.effects.slice(0, FACT_LIMIT)) {
    lines.push(
      `- Effect ${effect.capability} on ${compact(effect.sanitizedTarget)}: ${effect.status}`,
    );
  }
  if (lines.length === 1) lines.push("- No tool result or persistent effect was confirmed.");
  return lines;
}

function preservedDraftLines(input: OperationalFacts): string[] {
  const draft = input.assistantDraft?.trim();
  if (!draft) return [];
  return [
    "",
    "Preserved assistant text candidate:",
    "Use this text only where it remains consistent with the durable facts above; do not turn unsupported claims into facts.",
    draft,
  ];
}

function preservedDraftFallback(
  input: OperationalFacts,
  korean: boolean,
): string[] {
  const draft = input.assistantDraft?.trim();
  if (!draft) return [];
  return korean
    ? ["모델이 남긴 미완료 초안(검증되지 않은 내용이 포함될 수 있습니다):", draft]
    : ["Preserved unfinished draft (it may contain unverified content):", draft];
}

function compact(value: unknown): string {
  const encoded = typeof value === "string" ? value : safeJson(value);
  const oneLine = encoded.replace(/\s+/gu, " ").trim();
  return oneLine.length <= FACT_VALUE_LIMIT
    ? oneLine
    : `${oneLine.slice(0, FACT_VALUE_LIMIT - 1)}…`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[unavailable result]";
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Guided Turn was aborted");
}
