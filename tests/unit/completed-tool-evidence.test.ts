import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  compileCompletedToolEvidencePointers,
  toolResultPayloadForProvider,
} from "../../packages/butler-agent/src/agent/context/completed-tool-evidence.ts";

const measureSerializedBytes = (value: Record<string, unknown>) =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

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

test("request compilation defaults to pointer-only evidence without an admission capacity", () => {
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

test("request compilation admits a fresh provider-safe result inline when the exact request fits", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-capacity-inline-evidence-"));
  try {
    const packetized = toolResultPayloadForProvider({
      payload: {
        ok: true,
        output: {
          ok: true,
          path: "src/voice.ts",
          content: "EXACT_CAPACITY_ADMITTED_SOURCE",
          bytes: 31,
          truncated: false,
        },
      },
      toolName: "read_file",
      toolCallId: "call-capacity-inline",
      evidenceRetention: { butlerData: root, turnId: "turn-capacity-inline" },
    });
    const body = {
      messages: [{ role: "tool", content: JSON.stringify(packetized) }],
    };
    const fullCapacity = Buffer.byteLength(JSON.stringify(body), "utf8");
    const compiled = compileCompletedToolEvidencePointers({
      body,
      maxSerializedTokens: fullCapacity,
      measureSerializedTokens: measureSerializedBytes,
    });
    const content = JSON.parse((compiled.messages as Array<{ content: string }>)[0]!.content);

    expect(content.output.inline_output).toMatchObject({
      tool_name: "read_file",
      path: "src/voice.ts",
      content: "EXACT_CAPACITY_ADMITTED_SOURCE",
      truncated: false,
    });
    expect(Buffer.byteLength(JSON.stringify(compiled), "utf8")).toBeLessThanOrEqual(fullCapacity);
    expect(content.output.evidence_packet.rehydrate.tool).toBe("read_tool_evidence_artifact");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("capacity admission keeps bounded conversation messages inline without evidence rehydration", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-capacity-conversation-evidence-"));
  try {
    const marker = "DEPLOYMENT_CONTEXT_VISIBLE_WITHOUT_REHYDRATION";
    const packetized = toolResultPayloadForProvider({
      payload: {
        ok: true,
        output: {
          ok: true,
          session_id: "conversation-session-1",
          runtime_session_id: "private-runtime-session",
          query: "배포",
          anchor_message_id: null,
          anchor_event_id: null,
          direction: "around",
          returned: 1,
          truncated: false,
          messages: [{
            conversation_message_id: "message-1",
            turn_id: "turn-1",
            seq: 1,
            created_at: "2026-07-13T00:00:00.000Z",
            speaker: "user",
            role: "user",
            text: marker,
            parts: [],
          }],
          summaries: [],
        },
      },
      toolName: "read_conversation_context",
      toolCallId: "call-conversation-context",
      evidenceRetention: { butlerData: root, turnId: "turn-conversation-context" },
    });
    const body = {
      messages: [{ role: "tool", content: JSON.stringify(packetized) }],
    };
    const compiled = compileCompletedToolEvidencePointers({
      body,
      maxSerializedTokens: Buffer.byteLength(JSON.stringify(body), "utf8"),
      measureSerializedTokens: measureSerializedBytes,
    });
    const serialized = JSON.stringify(compiled);

    expect(serialized).toContain(marker);
    expect(serialized).toContain("inline_output");
    expect(serialized).not.toContain("private-runtime-session");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("request compilation keeps a non-fitting result pointer-only without losing rehydration", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-capacity-pointer-evidence-"));
  try {
    const packetized = toolResultPayloadForProvider({
      payload: {
        ok: true,
        output: {
          ok: true,
          path: "src/large.ts",
          content: "LARGE_INLINE_RESULT".repeat(200),
          bytes: 3_800,
          truncated: false,
        },
      },
      toolName: "read_file",
      toolCallId: "call-capacity-pointer",
      evidenceRetention: { butlerData: root, turnId: "turn-capacity-pointer" },
    });
    const body = {
      messages: [{ role: "tool", content: JSON.stringify(packetized) }],
    };
    const pointer = compileCompletedToolEvidencePointers({ body });
    const pointerCapacity = Buffer.byteLength(JSON.stringify(pointer), "utf8");
    const compiled = compileCompletedToolEvidencePointers({
      body,
      maxSerializedTokens: pointerCapacity,
      measureSerializedTokens: measureSerializedBytes,
    });
    const content = JSON.parse((compiled.messages as Array<{ content: string }>)[0]!.content);

    expect(content.output.inline_output).toBeUndefined();
    expect(JSON.stringify(compiled)).not.toContain("LARGE_INLINE_RESULT");
    expect(content.output.evidence_packet.rehydrate).toMatchObject({
      kind: "tool_evidence_artifact",
      tool: "read_tool_evidence_artifact",
    });
    expect(Buffer.byteLength(JSON.stringify(compiled), "utf8")).toBe(pointerCapacity);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("capacity admission prioritizes the newest completed result without content heuristics", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-capacity-recency-"));
  try {
    const result = (marker: string, callId: string) => toolResultPayloadForProvider({
      payload: {
        ok: true,
        output: {
          ok: true,
          path: `src/${marker}.ts`,
          content: marker.repeat(80),
          bytes: marker.length * 80,
          truncated: false,
        },
      },
      toolName: "read_file",
      toolCallId: callId,
      evidenceRetention: { butlerData: root, turnId: "turn-capacity-recency" },
    });
    const older = result("OLDER_RESULT", "call-older");
    const newer = result("NEWER_RESULT", "call-newer");
    const body = {
      messages: [
        { role: "tool", content: JSON.stringify(older) },
        { role: "tool", content: JSON.stringify(newer) },
      ],
    };
    const newestOnlyBody = structuredClone(body);
    const parsedOlder = JSON.parse(newestOnlyBody.messages[0]!.content);
    delete parsedOlder.output.inline_output;
    newestOnlyBody.messages[0]!.content = JSON.stringify(parsedOlder);
    const newestOnlyCapacity = Buffer.byteLength(JSON.stringify(newestOnlyBody), "utf8");
    const compiled = compileCompletedToolEvidencePointers({
      body,
      maxSerializedTokens: newestOnlyCapacity,
      measureSerializedTokens: measureSerializedBytes,
    });
    const messages = compiled.messages as Array<{ content: string }>;
    const compiledOlder = JSON.parse(messages[0]!.content);
    const compiledNewer = JSON.parse(messages[1]!.content);
    const serialized = JSON.stringify(compiled);

    expect(compiledOlder.output.inline_output).toBeUndefined();
    expect(compiledNewer.output.inline_output.content).toContain("NEWER_RESULT");
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(newestOnlyCapacity);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("capacity admission never re-inlines evidence older than the newest semantic tool block", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-capacity-semantic-block-"));
  try {
    const messages = Array.from({ length: 7 }, (_, index) => {
      const marker = `RESULT_${index + 1}`;
      const packetized = toolResultPayloadForProvider({
        payload: {
          ok: true,
          output: {
            ok: true,
            path: `src/${marker}.ts`,
            content: marker,
            bytes: marker.length,
            truncated: false,
          },
        },
        toolName: "read_file",
        toolCallId: `call-${index + 1}`,
        evidenceRetention: { butlerData: root, turnId: "turn-semantic-block" },
      });
      return { role: "tool", content: JSON.stringify(packetized) };
    });
    const body = { messages };
    const compiled = compileCompletedToolEvidencePointers({
      body,
      maxSerializedTokens: Buffer.byteLength(JSON.stringify(body), "utf8"),
      measureSerializedTokens: measureSerializedBytes,
    });
    const outputs = (compiled.messages as Array<{ content: string }>)
      .map((message) => JSON.parse(message.content).output);

    expect(outputs[0].inline_output).toBeUndefined();
    expect(outputs.slice(1).every((output) => output.inline_output !== undefined)).toBe(true);
    expect(outputs[0].evidence_packet.rehydrate.tool).toBe("read_tool_evidence_artifact");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("capacity compilation leaves unrelated JSON text byte-stable", () => {
  const userJson = '{  "request": "keep my whitespace", "value": 3  }';
  const schemaLookalike = '{  "schema": "butler.completed-tool-evidence.v1", "inline_output": "user text"  }';
  const body = {
    messages: [
      { role: "user", content: userJson },
      { role: "user", content: schemaLookalike },
    ],
  };
  const compiled = compileCompletedToolEvidencePointers({
    body,
    maxSerializedTokens: 100_000,
    measureSerializedTokens: measureSerializedBytes,
  });

  expect((compiled.messages as Array<{ content: string }>)[0]!.content).toBe(userJson);
  expect((compiled.messages as Array<{ content: string }>)[1]!.content).toBe(schemaLookalike);
});

test("all registered provider tool loops use the provider-neutral evidence boundary", () => {
  const root = join(import.meta.dir, "../..");
  const providerFiles = [
    "packages/butler-agent/src/agent/model-tool-loop/index.ts",
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
