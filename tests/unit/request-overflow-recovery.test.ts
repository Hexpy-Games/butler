import { expect, test } from "bun:test";
import { MonotonicOverflowRecovery } from "../../packages/butler-agent/src/agent/context/request-overflow-recovery.ts";
import type { ModelRequestAdmissionReceipt } from "../../packages/butler-agent/src/integrations/providers/shared/request-context-admission.ts";

function receipt(input: {
  compiledInputTokens: number;
  turnId?: string;
  modelRef?: string;
}): ModelRequestAdmissionReceipt {
  const modelRef = input.modelRef ?? "openai/gpt-5.4-mini";
  const turnId = input.turnId ?? "turn-overflow";
  const plan = {
    request_id: `request-${input.compiledInputTokens}`,
    turn_id: turnId,
    generation: 0,
    model_ref: modelRef,
    context_window_tokens: 128_000,
    requested_output_tokens: 100,
    max_input_tokens: null,
    provider_envelope_tokens: 0,
    input_capacity_tokens: 127_900,
    measurement: "model_token_estimate" as const,
    required_atoms: [],
    optional_atoms: [],
    tool_schema_tokens: 0,
    compiled_input_tokens: input.compiledInputTokens,
    budget_input_tokens: null,
    admission: "admitted" as const,
  };
  return {
    serialized_request_sha256: `sha-${input.compiledInputTokens}`,
    serialized_request: "{}",
    plan,
    metric: {
      category: "runtime",
      name: "model_request_context_admission",
      status: "ok",
      value: input.compiledInputTokens,
      unit: "token_upper_bound",
      dimensions: {},
    },
  };
}

test("overflow recovery authorizes only strictly smaller same-binding admitted requests", () => {
  const initial = receipt({ compiledInputTokens: 4_000 });
  const recovery = new MonotonicOverflowRecovery(initial);

  expect(recovery.consider(receipt({ compiledInputTokens: 4_000 }))).toEqual({
    action: "recoverable",
    reason: "request_not_smaller",
  });
  expect(recovery.consider(receipt({ compiledInputTokens: 3_000, turnId: "another-turn" }))).toEqual({
    action: "recoverable",
    reason: "binding_changed",
  });
  const smaller = receipt({ compiledInputTokens: 3_000 });
  expect(recovery.consider(smaller)).toEqual({ action: "retry", receipt: smaller });
  expect(recovery.consider(receipt({ compiledInputTokens: 3_500 }))).toEqual({
    action: "recoverable",
    reason: "request_not_smaller",
  });
});

test("cancellation permanently prevents another overflow recovery request", () => {
  const recovery = new MonotonicOverflowRecovery(receipt({ compiledInputTokens: 4_000 }));
  recovery.cancel();
  expect(recovery.consider(receipt({ compiledInputTokens: 5 }))).toEqual({
    action: "recoverable",
    reason: "cancelled",
  });
});
