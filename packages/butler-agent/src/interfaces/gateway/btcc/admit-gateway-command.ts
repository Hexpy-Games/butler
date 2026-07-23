import { createHash } from "node:crypto";
import type {
  AdmittedModelSelection,
  BtccTurnCommand,
} from "../../../agent/btcc/index.ts";
import type { ButlerContextSnapshot } from "../../../agent/btcc/context/index.ts";
import { verifyTurnExecutionControls } from "../../../gateways/core/turn-execution-controls.ts";
import type {
  InboundEnvelope,
  StoredSessionBinding,
} from "../../../test-support/harness/contracts.ts";
import { resolveModelMetadata } from "../../../integrations/providers/model-catalog.ts";

export function admitGatewayCommand(input: {
  binding: StoredSessionBinding;
  envelope: InboundEnvelope;
  turnId: string;
  context: ButlerContextSnapshot;
}): BtccTurnCommand {
  const raw = record(input.envelope.raw) ?? {};
  if (raw.btccResume === true) return { kind: "resume", turnId: input.turnId };

  const wake = record(raw.btccWake);
  if (wake) return admitWakeCommand(input, wake);

  return {
    kind: "run",
    turnId: input.turnId,
    sessionId: input.binding.sessionId,
    triggerKey: input.envelope.eventId,
    message: {
      messageId: input.envelope.message.id,
      content: requiredText(input.envelope.message.text, "BTCC user message"),
    },
    modelSelection: admitModel(input.binding, input.envelope),
    context: input.context,
  };
}

function admitWakeCommand(
  input: {
    binding: StoredSessionBinding;
    envelope: InboundEnvelope;
    turnId: string;
    context: ButlerContextSnapshot;
  },
  wake: Record<string, unknown>,
): BtccTurnCommand {
  const resultScopeRef = optionalText(wake.resultScopeRef);
  return {
    kind: "wake",
    turnId: input.turnId,
    sessionId: input.binding.sessionId,
    triggerKey: input.envelope.eventId,
    trigger: {
      triggerId: requiredText(wake.triggerId, "BTCC wake trigger id"),
      sourceTurnId: requiredText(wake.sourceTurnId, "BTCC wake source Turn"),
      authorizationRef: requiredText(wake.authorizationRef, "BTCC wake authorization"),
      content: requiredText(input.envelope.message.text, "BTCC wake content"),
    },
    modelSelection: admitModel(input.binding, input.envelope),
    context: resultScopeRef
      ? {
          ...input.context,
          baselineObservationScopeRefs: [
            ...new Set([
              ...input.context.baselineObservationScopeRefs,
              resultScopeRef,
            ]),
          ],
        }
      : input.context,
  };
}

function admitModel(
  binding: StoredSessionBinding,
  envelope: InboundEnvelope,
): AdmittedModelSelection {
  const controls = envelope.executionControls
    ? verifyTurnExecutionControls(envelope.executionControls)
    : null;
  const modelRef = requiredText(
    controls?.model_ref ?? binding.modelRef,
    "BTCC admitted model",
  );
  const separator = modelRef.indexOf("/");
  if (separator <= 0 || separator === modelRef.length - 1) {
    throw new Error(`BTCC admitted model is not canonical: ${modelRef}`);
  }
  const reasoningEffort = controls?.reasoning_effort
    ?? String(binding.metadata?.reasoning_effort ?? "medium");
  if (!isReasoningEffort(reasoningEffort)) {
    throw new Error(`BTCC admitted reasoning effort is invalid: ${reasoningEffort}`);
  }
  const admittedControls: Record<string, string | number | boolean> = controls
    ? {
        accessMode: controls.access_mode,
        planMode: controls.plan_mode,
        source: controls.source,
        sessionControlRevision: controls.session_control_revision,
        catalogGeneration: controls.catalog_generation,
      }
    : {
        accessMode: String(binding.metadata?.accessMode ?? "full_access"),
        planMode: Boolean(binding.metadata?.plan_mode),
        source: "stored_session_binding",
      };
  return {
    provider: modelRef.slice(0, separator),
    model: modelRef.slice(separator + 1),
    reasoningEffort,
    controls: admittedControls,
    controlsHash: controls?.integrity_hash ?? digest(admittedControls),
    contextWindowTokens: admittedContextWindow(binding, modelRef),
  };
}

function admittedContextWindow(
  binding: StoredSessionBinding,
  modelRef: string,
): number {
  const configured = binding.metadata?.context_window_tokens;
  if (
    typeof configured === "number" &&
    Number.isFinite(configured) &&
    configured > 0
  ) {
    return Math.trunc(configured);
  }
  return resolveModelMetadata(modelRef).context_window_tokens;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is missing`);
  return value;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isReasoningEffort(value: string): value is AdmittedModelSelection["reasoningEffort"] {
  return ["none", "low", "medium", "high", "xhigh", "max"].includes(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
