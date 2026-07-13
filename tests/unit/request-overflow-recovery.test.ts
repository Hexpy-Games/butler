import { expect, test } from "bun:test";
import { MonotonicOverflowRecovery } from "../../packages/butler-agent/src/agent/context/request-overflow-recovery.ts";
import { admitSerializedProviderRequest } from "../../packages/butler-agent/src/integrations/providers/shared/request-context-admission.ts";

function receipt(input: { text: string; turnId?: string; modelRef?: string }) {
  return admitSerializedProviderRequest({
    providerId: "openai",
    modelRef: input.modelRef ?? "openai/gpt-5.4-mini",
    body: { model: "gpt-5.4-mini", input: input.text },
    requestedOutputTokens: 100,
    turnId: input.turnId ?? "turn-overflow",
  });
}

test("overflow recovery authorizes only strictly smaller same-binding admitted requests", () => {
  const initial = receipt({ text: "x".repeat(4_000) });
  const recovery = new MonotonicOverflowRecovery(initial);

  expect(recovery.consider(receipt({ text: "x".repeat(4_000) }))).toEqual({
    action: "recoverable",
    reason: "request_not_smaller",
  });
  expect(recovery.consider(receipt({ text: "x".repeat(3_000), turnId: "another-turn" }))).toEqual({
    action: "recoverable",
    reason: "binding_changed",
  });
  const smaller = receipt({ text: "x".repeat(3_000) });
  expect(recovery.consider(smaller)).toEqual({ action: "retry", receipt: smaller });
  expect(recovery.consider(receipt({ text: "x".repeat(3_500) }))).toEqual({
    action: "recoverable",
    reason: "request_not_smaller",
  });
});

test("cancellation permanently prevents another overflow recovery request", () => {
  const recovery = new MonotonicOverflowRecovery(receipt({ text: "x".repeat(4_000) }));
  recovery.cancel();
  expect(recovery.consider(receipt({ text: "short" }))).toEqual({
    action: "recoverable",
    reason: "cancelled",
  });
});
