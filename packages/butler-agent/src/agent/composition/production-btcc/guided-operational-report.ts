import type { GuidedEffectJournalRecord } from "../../btcc/effects/index.ts";
import type {
  DurableWorkContext,
  DurableWorkView,
} from "../../btcc/durable-work/index.ts";
import type { GuidedToolJournalRecord } from "../../adapters/index.ts";
import type { FunctionToolPromptOptions } from
  "../../../integrations/providers/runtime-contracts.ts";

export const DEFAULT_GUIDED_TURN_LEASE_MS = 270_000;
export const DEFAULT_GUIDED_FINAL_REPORT_MS = 30_000;

const DEFAULT_GUIDED_QUIESCENCE_GRACE_MS = 5_000;
const FACT_LIMIT = 12;
const FACT_VALUE_LIMIT = 480;

type PromptRunner = (options: FunctionToolPromptOptions) => Promise<string>;

export async function runGuidedPromptWithOperationalReport(input: {
  promptRunner: PromptRunner;
  options: FunctionToolPromptOptions;
  parentSignal: AbortSignal;
  leaseStartedAt: number;
  originalRequest: string;
  leaseMs?: number;
  finalReportMs?: number;
  loadFacts: () => Promise<Omit<OperationalFacts, "originalRequest">>;
}): Promise<string> {
  const leaseMs = positiveMs(input.leaseMs, DEFAULT_GUIDED_TURN_LEASE_MS);
  const leaseDeadline = input.leaseStartedAt + leaseMs;
  const finalReportMs = Math.min(
    positiveMs(input.finalReportMs, DEFAULT_GUIDED_FINAL_REPORT_MS),
    Math.max(1, leaseMs - 1),
  );
  const mainDeadline = leaseDeadline - finalReportMs;
  const quiescenceGraceMs = Math.min(
    DEFAULT_GUIDED_QUIESCENCE_GRACE_MS,
    Math.max(1, Math.floor(finalReportMs / 4)),
  );
  try {
    const mainRemainingMs = mainDeadline - Date.now();
    if (mainRemainingMs <= 0) throw new GuidedOperationalWindowExpired();
    const runMain = (signal: AbortSignal) => input.promptRunner({
      ...input.options,
      signal,
      executeTool: (call) => input.options.executeTool({
        ...call,
        signal: call.signal ?? signal,
      }),
    });
    const text = await runInGuidedOperationalWindow({
      parentSignal: input.parentSignal,
      timeoutMs: mainRemainingMs,
      quiescenceGraceMs,
      run: runMain,
    });
    if (!text.trim()) throw new Error("Guided model returned no final text");
    return text;
  } catch {
    if (input.parentSignal.aborted) throwIfAborted(input.parentSignal);
  }

  const emptyFacts: OperationalFacts = {
    originalRequest: input.originalRequest,
    work: null,
    toolCalls: [],
    effects: [],
  };
  let facts = emptyFacts;
  const factLoadRemainingMs = leaseDeadline - Date.now();
  if (factLoadRemainingMs > 0) {
    try {
      facts = {
        originalRequest: input.originalRequest,
        ...await runInGuidedOperationalWindow({
          parentSignal: input.parentSignal,
          timeoutMs: factLoadRemainingMs,
          run: async () => await input.loadFacts(),
        }),
      };
    } catch {
      if (input.parentSignal.aborted) throwIfAborted(input.parentSignal);
    }
  }
  const fallback = guidedOperationalFallback(facts);
  const remainingMs = leaseDeadline - Date.now();
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
    } catch {
      if (input.parentSignal.aborted) throwIfAborted(input.parentSignal);
    }
  }
  return fallback;
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
  quiescenceGraceMs?: number;
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
  const running = Promise.resolve().then(() => input.run(controller.signal));
  try {
    return await Promise.race([running, interrupted]);
  } finally {
    if (
      controller.signal.reason instanceof GuidedOperationalWindowExpired &&
      !input.parentSignal.aborted &&
      (input.quiescenceGraceMs ?? 0) > 0
    ) {
      await waitForOperationalSettlement({
        running,
        parentSignal: input.parentSignal,
        timeoutMs: input.quiescenceGraceMs ?? 0,
      });
    }
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
  ].join("\n");
}

export function guidedOperationalFallback(input: OperationalFacts): string {
  const korean = /[가-힣]/.test(input.originalRequest);
  const facts = durableFactLines(input);
  const hasWork = Boolean(input.work);
  if (korean) {
    return [
      "요청을 끝까지 정리하는 과정에서 모델 연결 또는 실행 시간이 종료되었습니다.",
      facts.length > 0
        ? "현재까지 확인된 영속 기록:"
        : "실행 완료를 뒷받침하는 영속 기록은 없습니다.",
      ...facts,
      hasWork
        ? "완료되지 않은 부분은 완료로 처리하지 않았으며, 저장된 Work에서 이어갈 수 있습니다."
        : "완료되지 않은 부분은 완료로 처리하지 않았습니다.",
    ].join("\n");
  }
  return [
    "The model connection or execution window ended before I could finish the answer.",
    facts.length > 0
      ? "Confirmed durable records:"
      : "No durable record confirms completed execution.",
    ...facts,
    hasWork
      ? "I did not mark the unfinished part complete; the saved Work can be continued."
      : "I did not mark the unfinished part complete.",
  ].join("\n");
}

export type OperationalFacts = {
  originalRequest: string;
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
  const facts = durableFactLines(input);
  return [
    "Known durable facts:",
    ...(facts.length > 0
      ? facts
      : ["- No tool status, Work checkpoint, or persistent effect was confirmed."]),
  ];
}

function durableFactLines(input: OperationalFacts): string[] {
  const lines: string[] = [];
  const work = input.work && "work" in input.work ? input.work.work : input.work;
  if (work) {
    lines.push(`- Work status: ${work.status}`);
    if (work.latestCheckpoint) {
      lines.push(
        `- Latest progress (${work.latestCheckpoint.stage}): ${compact(work.latestCheckpoint.publicSummary)}`,
      );
      lines.push(`- Next recorded step: ${compact(work.latestCheckpoint.nextStep)}`);
    }
  }
  for (const call of input.toolCalls.slice(-FACT_LIMIT)) {
    lines.push(`- Tool ${call.toolName}: ${call.status}`);
  }
  for (const effect of input.effects.slice(0, FACT_LIMIT)) {
    lines.push(
      `- Effect ${effect.capability} on ${compact(effect.sanitizedTarget)}: ${effect.status}`,
    );
  }
  return lines;
}

function compact(value: string): string {
  const oneLine = value.replace(/\s+/gu, " ").trim();
  return oneLine.length <= FACT_VALUE_LIMIT
    ? oneLine
    : `${oneLine.slice(0, FACT_VALUE_LIMIT - 1)}…`;
}

async function waitForOperationalSettlement<T>(input: {
  running: Promise<T>;
  parentSignal: AbortSignal;
  timeoutMs: number;
}): Promise<void> {
  if (input.parentSignal.aborted) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeParentAbort = () => {};
  const settled = input.running.then(() => undefined, () => undefined);
  const graceExpired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(1, Math.trunc(input.timeoutMs)));
  });
  const parentAborted = new Promise<void>((resolve) => {
    const stop = () => resolve();
    input.parentSignal.addEventListener("abort", stop, { once: true });
    removeParentAbort = () => input.parentSignal.removeEventListener("abort", stop);
  });
  try {
    await Promise.race([settled, graceExpired, parentAborted]);
  } finally {
    if (timer) clearTimeout(timer);
    removeParentAbort();
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("Guided Turn was aborted");
}
