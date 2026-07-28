import { expect, test } from "bun:test";
import {
  hostedToolResultContent,
} from "../../packages/butler-agent/src/integrations/providers/shared/hosted-tool-result-context.ts";

test("hosted successful results preserve their exact structured payload", () => {
  const logs: string[] = [];
  const payload = { ok: true, output: { text: "EXACT_HOSTED_RESULT", value: 9 } };
  const content = hostedToolResultContent({
    payload,
    toolName: "read_exact",
    toolCallId: "call-exact",
    log: (line) => logs.push(line),
  });

  expect(JSON.parse(content)).toEqual(payload);
  expect(content).not.toContain("completed-tool-evidence");
  expect(content).not.toContain("evidence_packet");
  expect(logs).toEqual(["tool read_exact result serialized exactly"]);
});

test("hosted failures remain structured provider-valid observations", () => {
  const payload = {
    ok: false,
    output: {
      observation_kind: "test_failed",
      model_visible_content: "Expected article but received main",
    },
  };
  const content = hostedToolResultContent({
    payload,
    toolName: "run_command",
    toolCallId: "call-failed",
    log: () => {},
  });

  expect(JSON.parse(content)).toEqual(payload);
});
