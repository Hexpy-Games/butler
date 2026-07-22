export const DEFAULT_PROVIDER_ROUND_TIMEOUT_MS = 600_000;
export const DEFAULT_PROVIDER_ROUND_IDLE_TIMEOUT_MS = 120_000;

export type ProviderRoundTimeoutKind = "total" | "idle";

export interface ProviderRoundPolicy {
  totalTimeoutMs: number;
  idleTimeoutMs: number;
}

export interface ProviderRoundGuard {
  readonly signal: AbortSignal;
  readonly timeoutKind: ProviderRoundTimeoutKind | null;
  start(): void;
  recordProgress(): void;
  dispose(): void;
}

export async function runGuardedProviderRound<T>(input: {
  signal?: AbortSignal;
  policy?: Partial<ProviderRoundPolicy>;
  operation: (signal: AbortSignal) => Promise<T>;
  timeoutError: (kind: ProviderRoundTimeoutKind) => unknown;
  externalAbortError: () => unknown;
}): Promise<T> {
  const guard = createProviderRoundGuard({ signal: input.signal, policy: input.policy });
  try {
    guard.start();
    return await raceProviderRoundWithSignal(input.operation(guard.signal), guard.signal);
  } catch (error) {
    if (input.signal?.aborted) throw input.externalAbortError();
    if (guard.timeoutKind) throw input.timeoutError(guard.timeoutKind);
    throw error;
  } finally {
    guard.dispose();
  }
}

export function resolveProviderRoundPolicy(
  override: Partial<ProviderRoundPolicy> = {},
): ProviderRoundPolicy {
  return {
    totalTimeoutMs: positiveMilliseconds(
      override.totalTimeoutMs,
      process.env.BUTLER_PROVIDER_ROUND_TIMEOUT_MS,
      DEFAULT_PROVIDER_ROUND_TIMEOUT_MS,
    ),
    idleTimeoutMs: positiveMilliseconds(
      override.idleTimeoutMs,
      process.env.BUTLER_PROVIDER_ROUND_IDLE_TIMEOUT_MS,
      DEFAULT_PROVIDER_ROUND_IDLE_TIMEOUT_MS,
    ),
  };
}

export function createProviderRoundGuard(input: {
  signal?: AbortSignal;
  policy?: Partial<ProviderRoundPolicy>;
} = {}): ProviderRoundGuard {
  const policy = resolveProviderRoundPolicy(input.policy);
  const controller = new AbortController();
  let timeoutKind: ProviderRoundTimeoutKind | null = null;
  let disposed = false;
  let started = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let totalTimer: ReturnType<typeof setTimeout> | undefined;

  const abortForTimeout = (kind: ProviderRoundTimeoutKind) => {
    if (disposed || input.signal?.aborted || controller.signal.aborted) return;
    timeoutKind = kind;
    controller.abort(new Error(`Provider round ${kind} deadline exceeded.`));
  };
  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = unrefTimer(setTimeout(() => abortForTimeout("idle"), policy.idleTimeoutMs));
  };
  const onExternalAbort = () => {
    if (!controller.signal.aborted) controller.abort(input.signal?.reason);
  };

  input.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (input.signal?.aborted) onExternalAbort();

  return {
    signal: controller.signal,
    get timeoutKind() {
      return timeoutKind;
    },
    start() {
      if (started || disposed || controller.signal.aborted) return;
      started = true;
      totalTimer = unrefTimer(setTimeout(
        () => abortForTimeout("total"),
        policy.totalTimeoutMs,
      ));
      armIdleTimer();
    },
    recordProgress() {
      if (disposed || controller.signal.aborted) return;
      if (!started) {
        this.start();
        return;
      }
      armIdleTimer();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (totalTimer) clearTimeout(totalTimer);
      if (idleTimer) clearTimeout(idleTimer);
      input.signal?.removeEventListener("abort", onExternalAbort);
    },
  };
}

export async function raceProviderRoundWithSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error("Provider round aborted."));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function positiveMilliseconds(
  override: number | undefined,
  environmentValue: string | undefined,
  fallback: number,
): number {
  if (Number.isInteger(override) && Number(override) > 0) return Number(override);
  const parsed = Number(environmentValue);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function unrefTimer<T extends ReturnType<typeof setTimeout>>(timer: T): T {
  if (typeof timer === "object" && timer && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }
  return timer;
}
