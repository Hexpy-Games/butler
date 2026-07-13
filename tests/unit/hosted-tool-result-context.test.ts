import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  hostedToolResultContent,
} from "../../packages/butler-agent/src/integrations/providers/shared/hosted-tool-result-context.ts";

test("hosted successful results cross the provider boundary only as evidence packets", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-hosted-evidence-"));
  try {
    const content = hostedToolResultContent({
      payload: { ok: true, output: { marker: "RAW_HOSTED_RESULT", row_count: 3 } },
      toolName: "read_rows",
      toolCallId: "call-hosted",
      evidenceRetention: { butlerData: root, turnId: "turn-hosted" },
      log: () => {},
    });
    const completed = JSON.parse(content).output;

    expect(completed.schema).toBe("butler.completed-tool-evidence.v1");
    expect(completed.facts.row_count).toBe(3);
    expect(completed.evidence_packet.rehydrate.kind).toBe("tool_evidence_artifact");
    expect(content).not.toContain("RAW_HOSTED_RESULT");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hosted evidence artifacts preserve the exact result and digest", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-hosted-exact-"));
  try {
    const content = hostedToolResultContent({
      payload: { ok: true, output: { text: "EXACT_HOSTED_EVIDENCE", value: 9 } },
      toolName: "read_exact",
      toolCallId: "call-exact",
      evidenceRetention: { butlerData: root },
      log: () => {},
    });
    const packet = JSON.parse(content).output.evidence_packet;
    const artifact = JSON.parse(readFileSync(packet.rehydrate.path, "utf8"));

    expect(artifact.raw).toEqual({ text: "EXACT_HOSTED_EVIDENCE", value: 9 });
    expect(artifact.digest).toBe(packet.digest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
