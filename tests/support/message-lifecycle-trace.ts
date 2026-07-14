export const MESSAGE_LIFECYCLE_TRACE_SCHEMA =
  "butler.message-lifecycle-trace.v1" as const;

export type MessageLifecycleInvariant = "pass" | "fail";

export interface MessageLifecycleTraceStep {
  step: string;
  actualFunction: string;
  concreteInput: Record<string, unknown>;
  stateRead: Record<string, unknown>;
  stateWritten: Record<string, unknown>;
  outputOrNextCall: Record<string, unknown>;
  invariant: MessageLifecycleInvariant;
  evidence: string;
}

export interface MessageLifecycleTraceArtifact {
  schema_version: typeof MESSAGE_LIFECYCLE_TRACE_SCHEMA;
  scenario: string;
  session_id: string;
  turn_id: string;
  steps: MessageLifecycleTraceStep[];
}

export class MessageLifecycleTrace {
  private readonly steps: MessageLifecycleTraceStep[] = [];

  constructor(
    private readonly scenario: string,
    private readonly sessionId: string,
    private readonly turnId: string,
  ) {}

  record(step: MessageLifecycleTraceStep): void {
    if (!step.step.trim()) throw new Error("message_trace_step_missing");
    if (!step.actualFunction.trim()) {
      throw new Error("message_trace_function_missing");
    }
    if (!step.evidence.trim()) throw new Error("message_trace_evidence_missing");
    if (this.steps.some((entry) => entry.step === step.step)) {
      throw new Error(`message_trace_duplicate_step:${step.step}`);
    }
    this.steps.push(structuredClone(step));
  }

  artifact(): MessageLifecycleTraceArtifact {
    if (this.steps.length === 0) throw new Error("message_trace_empty");
    return {
      schema_version: MESSAGE_LIFECYCLE_TRACE_SCHEMA,
      scenario: this.scenario,
      session_id: this.sessionId,
      turn_id: this.turnId,
      steps: structuredClone(this.steps),
    };
  }

  requireFunctions(actualFunctions: readonly string[]): void {
    const observed = new Set(this.steps.map((step) => step.actualFunction));
    const missing = actualFunctions.filter((name) => !observed.has(name));
    if (missing.length > 0) {
      throw new Error(`message_trace_functions_missing:${missing.join(",")}`);
    }
  }
}

export function failedInvariantSteps(
  artifact: MessageLifecycleTraceArtifact,
): MessageLifecycleTraceStep[] {
  return artifact.steps.filter((step) => step.invariant === "fail");
}
