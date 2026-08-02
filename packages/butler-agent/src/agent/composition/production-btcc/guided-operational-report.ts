import type { FunctionToolPromptOptions } from
  "../../../integrations/providers/runtime-contracts.ts";
import { ModelProviderRequestError } from
  "../../../integrations/providers/provider-errors.ts";
import {
  guidedOperationalFallback,
  guidedOperationalReportPrompt,
  type OperationalFacts,
} from "./guided-operational-facts.ts";
import {
  GuidedOperationalLease,
  type GuidedOperationalDeadline,
} from "./guided-operational-lease.ts";

export {
  guidedOperationalFallback,
  guidedOperationalReportPrompt,
  type OperationalFacts,
} from "./guided-operational-facts.ts";

export {
  DEFAULT_GUIDED_ABSOLUTE_TURN_LEASE_MS,
  DEFAULT_GUIDED_FINAL_REPORT_MS,
  DEFAULT_GUIDED_TURN_LEASE_MS,
  GuidedOperationalLease,
} from "./guided-operational-lease.ts";

const DEFAULT_GUIDED_QUIESCENCE_GRACE_MS = 5_000;
type PromptRunner = (options: FunctionToolPromptOptions) => Promise<string>;

export async function runGuidedPromptWithOperationalReport(input: {
  promptRunner: PromptRunner;
  options: FunctionToolPromptOptions;
  parentSignal: AbortSignal;
  leaseStartedAt: number;
  originalRequest: string;
  leaseMs?: number;
  finalReportMs?: number;
  operationalLease?: GuidedOperationalLease;
  loadFacts: () => Promise<Omit<OperationalFacts, "originalRequest">>;
}): Promise<string> {
  const lease = input.operationalLease ?? new GuidedOperationalLease({
    startedAt: input.leaseStartedAt,
    leaseMs: input.leaseMs,
    finalReportMs: input.finalReportMs,
  });
  const finalReportMs = lease.finalReportMs;
  const quiescenceGraceMs = Math.min(
    DEFAULT_GUIDED_QUIESCENCE_GRACE_MS,
    Math.max(1, Math.floor(finalReportMs / 4)),
  );
  try {
    const mainRemainingMs = lease.mainDeadline() - Date.now();
    if (mainRemainingMs <= 0) throw new GuidedOperationalWindowExpired();
    const runMain = (signal: AbortSignal) => input.promptRunner({
      ...input.options,
      signal,
      executeTool: async (call) => withTurnTimeRemaining(
        await input.options.executeTool({
          ...call,
          signal: call.signal ?? signal,
        }),
        lease.mainDeadline(),
      ),
    });
    const text = await runInGuidedOperationalWindow({
      parentSignal: input.parentSignal,
      timeoutMs: mainRemainingMs,
      deadline: lease.mainWindow(),
      quiescenceGraceMs,
      run: runMain,
    });
    if (text.trim()) return text;
  } catch (error) {
    if (input.parentSignal.aborted) throwIfAborted(input.parentSignal);
    if (!allowsOperationalReport(error)) throw error;
  }

  const emptyFacts: OperationalFacts = {
    originalRequest: input.originalRequest,
    work: null,
    toolCalls: [],
    effects: [],
  };
  let facts = emptyFacts;
  const factLoadRemainingMs = lease.leaseDeadline() - Date.now();
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
  const remainingMs = lease.leaseDeadline() - Date.now();
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

function allowsOperationalReport(error: unknown): boolean {
  return error instanceof GuidedOperationalWindowExpired ||
    error instanceof ModelProviderRequestError;
}

export async function runInGuidedOperationalWindow<T>(input: {
  parentSignal: AbortSignal;
  timeoutMs: number;
  deadline?: GuidedOperationalDeadline;
  quiescenceGraceMs?: number;
  timer?: {
    set(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
    clear(timer: ReturnType<typeof setTimeout>): void;
  };
  run: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  throwIfAborted(input.parentSignal);
  const controller = new AbortController();
  const expire = () => controller.abort(new GuidedOperationalWindowExpired());
  const cancel = () => controller.abort(input.parentSignal.reason);
  input.parentSignal.addEventListener("abort", cancel, { once: true });
  const timerApi = input.timer ?? {
    set: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
    clear: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  };
  const fixedDeadline = Date.now() + input.timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const armDeadline = () => {
    if (timer) timerApi.clear(timer);
    const remainingMs = input.deadline
      ? input.deadline.deadline() - input.deadline.now()
      : fixedDeadline - Date.now();
    timer = timerApi.set(expire, Math.max(1, Math.trunc(remainingMs)));
  };
  const unsubscribeDeadline = input.deadline?.subscribe(armDeadline) ?? (() => {});
  armDeadline();
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
    if (timer) timerApi.clear(timer);
    unsubscribeDeadline();
    input.parentSignal.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", rejectOnAbort);
  }
}

async function rejectOperationalToolCall(): Promise<never> {
  throw new Error("Operational final report cannot call tools");
}

function withTurnTimeRemaining(result: unknown, deadline: number): unknown {
  const turnTimeRemainingSeconds = Math.max(
    0,
    Math.ceil((deadline - Date.now()) / 1_000),
  );
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return {
      ...result as Record<string, unknown>,
      turn_time_remaining_seconds: turnTimeRemainingSeconds,
    };
  }
  return {
    output: result,
    turn_time_remaining_seconds: turnTimeRemainingSeconds,
  };
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
