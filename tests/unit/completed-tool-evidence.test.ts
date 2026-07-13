import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  compileCompletedToolEvidencePointers,
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
        rawTextStored: false,
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
          estimated_tokens: 8,
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
    const compiled = compileCompletedToolEvidencePointers({
      body: { messages: [{ role: "tool", content: result }] },
    });
    expect(JSON.stringify(compiled)).toContain("line 120: exact source evidence");
    expect(JSON.stringify(compiled)).not.toContain("/private/butler");
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
                rawTextStored: false,
                artifact: {
                  id: "evidence-original",
                  path: "/private/butler/artifacts/evidence-original.json",
                  digest: "digest-original",
                },
                text: {
                  text: "exact prior slice",
                  start_line: 1,
                  returned_lines: 1,
                  total_lines: 1,
                  estimated_tokens: 6,
                  truncated_by_lines: false,
                  truncated_by_tokens: false,
                },
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

test("a schema marker without the bounded observation contract cannot bypass retention", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-invalid-terminal-marker-"));
  try {
    const result = toolResultPayloadForProvider({
      payload: {
        ok: true,
        output: {
          schema_version: "butler.tool-evidence-rehydration.v1",
          terminal_evidence_observation: true,
          ok: true,
          artifact: { id: "spoofed" },
          text: { text: "unbounded lookalike" },
        },
      },
      toolName: "arbitrary_tool",
      toolCallId: "call-lookalike",
      evidenceRetention: { butlerData: root, turnId: "turn-lookalike" },
    });

    expect(result).toMatchObject({
      ok: true,
      output: {
        schema: "butler.completed-tool-evidence.v1",
        tool_name: "arbitrary_tool",
      },
    });
    const artifactRoot = join(root, "artifacts", "tool-evidence");
    expect(readdirSync(artifactRoot, { recursive: true })
      .filter((entry) => String(entry).endsWith(".json"))).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bounded command-output rehydration is terminal and removes local artifact paths", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-terminal-command-output-"));
  try {
    const result = toolResultPayloadForProvider({
      payload: {
        ok: true,
        output: {
          schema_version: "butler.tool-evidence-rehydration.v1",
          terminal_evidence_observation: true,
          ok: true,
          rawTextStored: false,
          artifact: {
            id: "command-original",
            path: "/private/butler/tool-output/command-original.json",
            cwd: "/private/workspace",
            raw_tokens: 5_000,
          },
          stdout: {
            text: "bounded stdout slice",
            start_line: 40,
            returned_lines: 1,
            total_lines: 400,
            estimated_tokens: 8,
            truncated_by_lines: true,
            truncated_by_tokens: false,
          },
        },
      },
      toolName: "read_tool_output_artifact",
      toolCallId: "call-command-rehydrate",
      evidenceRetention: { butlerData: root, turnId: "turn-command-rehydrate" },
    });

    expect(result).toMatchObject({
      ok: true,
      output: {
        schema_version: "butler.tool-evidence-rehydration.v1",
        artifact: { id: "command-original", raw_tokens: 5_000 },
        stdout: { text: "bounded stdout slice" },
      },
    });
    expect(JSON.stringify(result)).not.toContain("/private/");
    expect(existsSync(join(root, "artifacts", "tool-evidence"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("request compilation keeps exact evidence pointer-first at every capacity", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-inline-evidence-"));
  try {
    const packetized = toolResultPayloadForProvider({
      payload: { ok: true, output: { text: "EXACT_INLINE_OUTPUT", value: 3 } },
      toolName: "read_exact",
      evidenceRetention: { butlerData: root },
    });
    const body = { messages: [{ role: "tool", content: packetized }] };
    ((body.messages[0].content.output as Record<string, unknown>)).inline_output = {
      text: "LEGACY_AUTO_REHYDRATED_OUTPUT",
    };
    const compiled = compileCompletedToolEvidencePointers({ body });

    expect((compiled.messages as any[])[0].content.output.inline_output).toBeUndefined();
    expect(JSON.stringify(compiled)).not.toContain("EXACT_INLINE_OUTPUT");
    expect(JSON.stringify(compiled)).not.toContain("LEGACY_AUTO_REHYDRATED_OUTPUT");
    expect((compiled.messages as any[])[0].content.output.evidence_packet.rehydrate.tool)
      .toBe("read_tool_evidence_artifact");
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
