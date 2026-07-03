import type { RuntimeTurnInput } from "../../../../test-support/harness/contracts.ts";
import {
  createTurnLatencyMetricRecorder,
  type FirstToolEventKind,
  type TurnLatencyMetricRecorder,
} from "../../../../operations/metrics/turn-latency.ts";

const TURN_LATENCY_TRACKER = Symbol.for("butler.native.turnLatencyTracker.v1");

interface TurnLatencyMetadata extends Record<string, unknown> {
  [TURN_LATENCY_TRACKER]?: TurnLatencyMetricRecorder;
}

export function installTurnLatencyTracker(input: {
  turnInput: RuntimeTurnInput;
  butlerData: string;
  startedAt: number;
  role?: string;
  runtime?: string;
  model?: string;
  now?: () => number;
}): TurnLatencyMetricRecorder {
  const tracker = createTurnLatencyMetricRecorder({
    butlerData: input.butlerData,
    startedAt: input.startedAt,
    role: input.role,
    runtime: input.runtime,
    model: input.model,
    now: input.now,
  });
  input.turnInput.metadata ??= {};
  Object.defineProperty(input.turnInput.metadata, TURN_LATENCY_TRACKER, {
    configurable: true,
    enumerable: false,
    value: tracker,
  });
  return tracker;
}

export function turnLatencyTrackerFromInput(
  input: RuntimeTurnInput,
): TurnLatencyMetricRecorder | undefined {
  return (input.metadata as TurnLatencyMetadata | undefined)?.[TURN_LATENCY_TRACKER];
}

export function recordFirstToolEventFromTurnInput(
  input: RuntimeTurnInput,
  eventKind: FirstToolEventKind,
): void {
  turnLatencyTrackerFromInput(input)?.recordFirstToolEvent({ eventKind });
}
