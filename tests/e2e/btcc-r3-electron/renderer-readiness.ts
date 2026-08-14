export interface RendererReadyFailure {
  stage: "renderer_ready";
  cause: "electron_exited" | "renderer_ready_timeout";
  owner: "electron_process" | "electron_harness";
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export type RendererReadinessDecision =
  | { state: "waiting" }
  | { state: "ready" }
  | { state: "failed"; failure: RendererReadyFailure };

export class RendererReadyError extends Error {
  readonly failure: RendererReadyFailure;

  constructor(failure: RendererReadyFailure, lastError?: string) {
    const message = failure.cause === "electron_exited"
      ? `Electron exited before its renderer was ready (exitCode=${String(failure.exitCode)}, signal=${String(failure.signal)}).`
      : `Timed out connecting to Electron renderer: ${lastError ?? "CDP endpoint is not ready."}`;
    super(message);
    this.name = "RendererReadyError";
    this.failure = failure;
  }
}

export function evaluateRendererReadiness(input: {
  ready: boolean;
  timedOut: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}): RendererReadinessDecision {
  if (input.exitCode !== null || input.signal !== null) {
    return {
      state: "failed",
      failure: {
        stage: "renderer_ready",
        cause: "electron_exited",
        owner: "electron_process",
        exitCode: input.exitCode,
        signal: input.signal,
      },
    };
  }
  if (input.ready) return { state: "ready" };
  if (input.timedOut) {
    return {
      state: "failed",
      failure: {
        stage: "renderer_ready",
        cause: "renderer_ready_timeout",
        owner: "electron_harness",
        exitCode: null,
        signal: null,
      },
    };
  }
  return { state: "waiting" };
}

export function requireRendererReadiness(
  decision: RendererReadinessDecision,
  lastError?: string,
): void {
  if (decision.state === "failed") {
    throw new RendererReadyError(decision.failure, lastError);
  }
}
