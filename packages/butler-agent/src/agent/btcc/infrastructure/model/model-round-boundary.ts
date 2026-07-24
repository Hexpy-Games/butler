import { resolveProviderRoundPolicy } from
  "../../../../integrations/providers/shared/provider-round-guard.ts";

export type ModelRoundBoundaryResult<T> =
  | { kind: "completed"; value: T }
  | { kind: "cancelled" }
  | { kind: "timed_out" };

export async function runWithinModelRoundBoundary<T>(input: {
  signal?: AbortSignal;
  totalTimeoutMs?: number;
  run: (signal: AbortSignal) => Promise<T>;
}): Promise<ModelRoundBoundaryResult<T>> {
  if (input.signal?.aborted) return { kind: "cancelled" };

  const controller = new AbortController();
  const timeoutMs = resolveProviderRoundPolicy({
    totalTimeoutMs: input.totalTimeoutMs,
  }).totalTimeoutMs;
  let timedOut = false;

  const onExternalAbort = () => controller.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", onExternalAbort, { once: true });

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Selected model round deadline exceeded."));
  }, timeoutMs);
  if (typeof timeout === "object" && "unref" in timeout) timeout.unref();

  const boundary = new Promise<ModelRoundBoundaryResult<T>>((resolve) => {
    controller.signal.addEventListener("abort", () => {
      resolve(timedOut ? { kind: "timed_out" } : { kind: "cancelled" });
    }, { once: true });
  });
  try {
    const running = Promise.resolve()
      .then(async () => await input.run(controller.signal))
      .then((value): ModelRoundBoundaryResult<T> => ({ kind: "completed", value }));
    return await Promise.race([running, boundary]);
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", onExternalAbort);
  }
}
