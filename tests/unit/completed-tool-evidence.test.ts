import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
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

test("rehydrated exact evidence is a terminal observation and creates no wrapper artifact", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-terminal-rehydration-"));
  try {
    const payload = {
      ok: true,
      output: {
        schema_version: "butler.tool-evidence-rehydration.v1",
        terminal_evidence_observation: true,
        ok: true,
        artifact: {
          id: "evidence-original",
          path: "/private/butler/artifacts/evidence-original.json",
          digest: "original-digest",
          tool_name: "read_file",
        },
        text: {
          text: "line 120: exact source evidence",
          start_line: 120,
          returned_lines: 1,
          total_lines: 300,
          truncated_by_lines: true,
          truncated_by_tokens: false,
        },
      },
    };
    const result = toolResultPayloadForProvider({
      payload,
      toolName: "read_tool_evidence_artifact",
      toolCallId: "call-rehydrate",
      evidenceRetention: { butlerData: root, turnId: "turn-rehydrate" },
    });

    expect(result).toMatchObject({
      ok: true,
      output: {
        schema_version: "butler.tool-evidence-rehydration.v1",
        terminal_evidence_observation: true,
        artifact: { id: "evidence-original" },
        text: { text: "line 120: exact source evidence" },
      },
    });
    expect(JSON.stringify(result)).not.toContain("butler.completed-tool-evidence.v1");
    expect(JSON.stringify(result)).not.toContain("/private/butler");
    const repeated = toolResultPayloadForProvider({
      payload,
      toolName: "read_tool_evidence_artifact",
      toolCallId: "call-rehydrate-repeat",
      evidenceRetention: { butlerData: root, turnId: "turn-rehydrate" },
    });
    expect(repeated).toEqual(result);
    const artifactRoot = join(root, "artifacts", "tool-evidence");
    expect(existsSync(artifactRoot) ? readdirSync(artifactRoot, { recursive: true }).length : 0).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("run_work_block packetizes ordered child results without retaining its orchestration envelope", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-work-block-evidence-"));
  try {
    const result = toolResultPayloadForProvider({
      payload: {
        ok: true,
        output: {
          butler_work_block_result: true,
          frontier: { stage: "workspace_execution" },
          results: [
            {
              name: "read_file",
              args: { path: "src/voice.ts" },
              ok: true,
              output: { path: "src/voice.ts", content: "exact source" },
            },
            {
              name: "read_tool_evidence_artifact",
              args: { artifact_id: "evidence-original" },
              ok: true,
              output: {
                schema_version: "butler.tool-evidence-rehydration.v1",
                terminal_evidence_observation: true,
                ok: true,
                artifact: {
                  id: "evidence-original",
                  path: "/private/butler/artifacts/evidence-original.json",
                  digest: "digest-original",
                },
                text: { text: "exact prior slice", start_line: 1, returned_lines: 1, total_lines: 1 },
              },
            },
          ],
        },
      },
      toolName: "run_work_block",
      toolCallId: "call-work-block",
      evidenceRetention: { butlerData: root, turnId: "turn-work-block" },
    });

    expect(result).toMatchObject({
      ok: true,
      output: {
        butler_work_block_result: true,
        results: [
          {
            name: "read_file",
            ok: true,
            output: { schema: "butler.completed-tool-evidence.v1" },
          },
          {
            name: "read_tool_evidence_artifact",
            ok: true,
            output: {
              schema_version: "butler.tool-evidence-rehydration.v1",
              terminal_evidence_observation: true,
            },
          },
        ],
      },
    });
    const files = readdirSync(join(root, "artifacts", "tool-evidence"), { recursive: true })
      .filter((entry) => String(entry).endsWith(".json"));
    expect(files).toHaveLength(1);
    const artifact = JSON.parse(readFileSync(join(root, "artifacts", "tool-evidence", String(files[0])), "utf8"));
    expect(artifact.tool_name).toBe("read_file");
    expect(JSON.stringify(artifact)).not.toContain("butler_work_block_result");
    expect(JSON.stringify(artifact)).not.toContain("exact prior slice");
    expect(JSON.stringify(result)).not.toContain("/private/butler");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
