import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  compileCompletedToolEvidenceInline,
  toolResultPayloadForProvider,
} from "../../packages/butler-agent/src/agent/context/completed-tool-evidence.ts";

test("completed tool evidence retains exact raw output while exposing only safe packet data", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-completed-evidence-"));
  try {
    const result = toolResultPayloadForProvider({
      payload: {
        ok: true,
        output: {
          title: "verified result",
          token: "sk-secret-value-must-not-cross",
          text: "exact body",
        },
      },
      toolName: "read_source",
      toolCallId: "call-source",
      evidenceRetention: { butlerData: root, turnId: "turn-source" },
    });
    const completed = result.output as Record<string, any>;
    const serialized = JSON.stringify(result);
    const artifact = JSON.parse(
      readFileSync(completed.evidence_packet.rehydrate.path, "utf8"),
    );

    expect(completed.schema).toBe("butler.completed-tool-evidence.v1");
    expect(completed.facts).toEqual({ title: "verified result" });
    expect(serialized).not.toContain("sk-secret-value-must-not-cross");
    expect(serialized).not.toContain("exact body");
    expect(artifact.raw.token).toBe("sk-secret-value-must-not-cross");
    expect(artifact.raw.text).toBe("exact body");
    expect(artifact.digest).toBe(completed.evidence_packet.digest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed tool results remain unchanged structured observations", () => {
  const payload = {
    ok: false,
    error: "invalid arguments",
    output: { observation_kind: "tool_invalid_arguments" },
  };
  expect(toolResultPayloadForProvider({
    payload,
    toolName: "lookup",
    toolCallId: "call-failed",
  })).toEqual(payload);
});

test("request compilation inlines exact evidence only when the finalized body fits", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-inline-evidence-"));
  try {
    const packetized = toolResultPayloadForProvider({
      payload: { ok: true, output: { text: "EXACT_INLINE_OUTPUT", value: 3 } },
      toolName: "read_exact",
      evidenceRetention: { butlerData: root },
    });
    const body = { messages: [{ role: "tool", content: packetized }] };
    const baselineBytes = Buffer.byteLength(JSON.stringify(body), "utf8");

    const fits = compileCompletedToolEvidenceInline({
      body,
      serializedUtf8Capacity: baselineBytes + 1_000,
    });
    const doesNotFit = compileCompletedToolEvidenceInline({
      body,
      serializedUtf8Capacity: baselineBytes,
    });

    expect((fits.messages as any[])[0].content.output.inline_output).toEqual({
      text: "EXACT_INLINE_OUTPUT",
      value: 3,
    });
    expect((doesNotFit.messages as any[])[0].content.output.inline_output).toBeUndefined();
    expect(JSON.stringify(doesNotFit)).not.toContain("EXACT_INLINE_OUTPUT");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("all registered provider tool loops use the provider-neutral evidence boundary", () => {
  const root = join(import.meta.dir, "../..");
  const providerFiles = [
    "packages/butler-agent/src/agent/turn/agent-loop.ts",
    "packages/butler-agent/src/integrations/providers/shared/hosted-tool-result-context.ts",
    "packages/butler-agent/src/integrations/providers/anthropic/runtime.ts",
    "packages/butler-agent/src/integrations/providers/google/runtime.ts",
    "packages/butler-agent/src/integrations/providers/local/execution.ts",
  ];

  for (const relativePath of providerFiles) {
    const source = readFileSync(join(root, relativePath), "utf8");
    expect(source.toLowerCase()).toContain("toolresultpayloadforprovider");
  }
});
