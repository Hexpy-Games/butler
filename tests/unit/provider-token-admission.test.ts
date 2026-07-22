import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { admitSerializedProviderRequest } from
  "../../packages/butler-agent/src/integrations/providers/shared/request-context-admission.ts";

test("serialized input is admitted by model tokens instead of UTF-8 bytes", () => {
  const receipt = admitSerializedProviderRequest({
    providerId: "openai",
    modelRef: "openai/gpt-5.6-sol",
    body: { model: "gpt-5.6-sol", input: "안녕하세요 ".repeat(30) },
    contextWindowTokens: 200,
    maxOutputTokens: 20,
    requestedOutputTokens: 20,
  });

  expect(Buffer.byteLength(receipt.serialized_request, "utf8")).toBeGreaterThan(
    receipt.plan.input_capacity_tokens!,
  );
  expect(receipt.plan.compiled_input_tokens).toBeLessThan(receipt.plan.input_capacity_tokens!);
  expect(receipt.plan.admission).toBe("admitted");
});
