import {
  recordTurnPreparationStepMetric,
  type TurnPreparationStep,
} from "../../operations/metrics/first-visible-latency.ts";

export interface TurnPreparationMetricContext {
  butlerData: string;
  role?: string;
  runtime?: string;
  model?: string;
}

interface StepInput extends TurnPreparationMetricContext {
  step: TurnPreparationStep;
}

interface SkippedStepInput extends StepInput {
  skippedReason: string;
}

function recordMeasuredStep(input: StepInput & {
  startedAt: number;
  status: "ok" | "error";
}): void {
  recordTurnPreparationStepMetric({
    butlerData: input.butlerData,
    step: input.step,
    durationMs: Date.now() - input.startedAt,
    status: input.status,
    role: input.role,
    runtime: input.runtime,
    model: input.model,
  });
}

export async function measureTurnPreparationStep<T>(
  input: StepInput,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await operation();
    recordMeasuredStep({ ...input, startedAt, status: "ok" });
    return result;
  } catch (error) {
    recordMeasuredStep({ ...input, startedAt, status: "error" });
    throw error;
  }
}

export function measureTurnPreparationStepSync<T>(
  input: StepInput,
  operation: () => T,
): T {
  const startedAt = Date.now();
  try {
    const result = operation();
    recordMeasuredStep({ ...input, startedAt, status: "ok" });
    return result;
  } catch (error) {
    recordMeasuredStep({ ...input, startedAt, status: "error" });
    throw error;
  }
}

export function recordTurnPreparationStepSkipped(input: SkippedStepInput): void {
  recordTurnPreparationStepMetric({
    butlerData: input.butlerData,
    step: input.step,
    durationMs: 0,
    status: "skipped",
    role: input.role,
    runtime: input.runtime,
    model: input.model,
    skippedReason: input.skippedReason,
  });
}
