import { expect, test } from "bun:test";
import { modelFacingToolOutput } from "../../packages/butler-agent/src/agent/turn/native/turn-runner/model-facing-tool-output.ts";

test("provider-facing tool output removes duplicate decisions and normalizes workspace paths", () => {
  const output = modelFacingToolOutput({
    ok: true,
    cwd: "/private/var/tmp/workspace",
    stdout: [
      "/private/var/tmp/workspace/package.json",
      "/private/var/tmp/workspace/src/browser-capture.ts",
    ].join("\n"),
    public_work_decision: { decisionId: "decision-1" },
    public_work_decision_context: "large repeated decision history",
  }, "/var/tmp/workspace");

  expect(output).toEqual({
    ok: true,
    cwd: ".",
    stdout: "package.json\nsrc/browser-capture.ts",
  });
});
