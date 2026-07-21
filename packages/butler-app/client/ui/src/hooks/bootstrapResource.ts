const DEFAULT_INITIAL_FAILURE_THRESHOLD = 4;
const DEFAULT_RETRY_DELAYS_MS = [250, 750, 1_500, 5_000] as const;

type BootstrapRecoveryResult = "ready" | "cancelled";

interface RecoverBootstrapResourceOptions<T> {
  load: () => Promise<T>;
  onReady: (value: T) => void;
  onUnavailable: () => void;
  isCancelled: () => boolean;
  signal?: AbortSignal;
  initialFailureThreshold?: number;
  retryDelaysMs?: readonly number[];
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

export async function recoverBootstrapResource<T>({
  load,
  onReady,
  onUnavailable,
  isCancelled,
  signal,
  initialFailureThreshold = DEFAULT_INITIAL_FAILURE_THRESHOLD,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  sleep = defaultSleep,
}: RecoverBootstrapResourceOptions<T>): Promise<BootstrapRecoveryResult> {
  const failureThreshold = Math.max(1, Math.floor(initialFailureThreshold));
  const delays = retryDelaysMs.length > 0 ? retryDelaysMs : [0];
  let failures = 0;
  let unavailableReported = false;

  while (!isCancelled()) {
    try {
      const value = await load();
      if (isCancelled()) return "cancelled";
      onReady(value);
      return "ready";
    } catch {
      failures += 1;
      if (!unavailableReported && failures >= failureThreshold) {
        unavailableReported = true;
        if (!isCancelled()) onUnavailable();
      }
      if (isCancelled()) return "cancelled";
      const delayIndex = Math.min(failures - 1, delays.length - 1);
      await sleep(Math.max(0, delays[delayIndex] ?? 0), signal);
    }
  }

  return "cancelled";
}

function defaultSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, delayMs);
    signal?.addEventListener("abort", finish, { once: true });
  });
}
