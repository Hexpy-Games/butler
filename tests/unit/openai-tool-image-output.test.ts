import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runBtccAgentLoop,
  type BtccAgentLoopToolDefinition,
} from "../../packages/butler-agent/src/agent/btcc/agent-loop/index.ts";
import type { ModelRoundPort } from
  "../../packages/butler-agent/src/agent/btcc/ports/model-round.ts";
import { runOpenAIModelRound } from
  "../../packages/butler-agent/src/integrations/providers/openai/model-round.ts";
import { createBtccToolExecutionEnvelope } from
  "../../packages/butler-agent/src/agent/btcc/agent-loop/tool-execution.ts";

const originalFetch = globalThis.fetch;
const originalOpenAIBaseUrl = process.env.OPENAI_BASE_URL;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalOpenAIBaseUrl === undefined) {
    delete process.env.OPENAI_BASE_URL;
  } else {
    process.env.OPENAI_BASE_URL = originalOpenAIBaseUrl;
  }
});

const previewTool: BtccAgentLoopToolDefinition = {
  name: "inspect_workspace_page",
  description: "Inspect a workspace page and return its visual preview.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
};

function openAIModelRound(responses: readonly Record<string, unknown>[]): {
  modelRound: ModelRoundPort;
  requests: Record<string, unknown>[];
} {
  const requests: Record<string, unknown>[] = [];
  let responseIndex = 0;
  process.env.OPENAI_BASE_URL = "https://example.test/v1";
  globalThis.fetch = (async (_input: RequestInfo | URL, init: RequestInit | undefined) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(body);
    const response = responses[responseIndex];
    responseIndex += 1;
    if (!response) throw new Error("scripted_openai_response_exhausted");
    return Response.json(response);
  }) as unknown as typeof fetch;

  return {
    requests,
    modelRound: {
      runRound: (request) => runOpenAIModelRound(request, {
        authorization: "Bearer test-key",
        mode: "api_key",
      }),
    },
  };
}

function previewOutput(relativePath: string): Record<string, unknown> {
  return {
    ok: true,
    model_image_attachments: [{
      path: relativePath,
      media_type: "image/jpeg",
      name: "desktop preview",
    }],
  };
}

test("OpenAI stateless transport carries the canonical compact replay request", async () => {
  const continuityTool = { ...previewTool, name: "replace_phase_continuity" };
  const sourceTool = { ...previewTool, name: "read_file" };
  const { modelRound, requests } = openAIModelRound([
    {
      id: "compact-response-1",
      model: "gpt-5.5",
      output: [
        {
          type: "function_call",
          call_id: "compact-continuity",
          name: "replace_phase_continuity",
          arguments: "{}",
        },
        {
          type: "function_call",
          call_id: "compact-source",
          name: "read_file",
          arguments: "{}",
        },
      ],
    },
    {
      id: "compact-response-2",
      model: "gpt-5.5",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Compact replay received." }],
      }],
    },
  ]);

  const result = await runBtccAgentLoop({
    prompt: "Inspect the durable result.",
    model: "openai/gpt-5.5",
    tools: [continuityTool, sourceTool],
    compactReplay: { enabled: true, initialPhaseContinuity: null },
    modelRound,
    executeTool: async (call) => call.name === "replace_phase_continuity"
      ? createBtccToolExecutionEnvelope(
          { ok: true },
          { kind: "phase_continuity", value: { objective: "inspect" } },
        )
      : createBtccToolExecutionEnvelope(
          { ok: true, content: "CANONICAL_COMPACT_RESULT" },
          {
            kind: "source",
            identity: {
              kind: "direct",
              result_ref: `guided-result-${"1".repeat(64)}`,
              revision: null,
              tool_name: "read_file",
              status: "completed",
              result_sha256: null,
              outcome: "succeeded",
              completeness: "complete",
            },
          },
        ),
  });

  expect(result.finalText).toBe("Compact replay received.");
  expect(requests).toHaveLength(2);
  const secondInput = JSON.stringify(requests[1]?.input);
  expect(secondInput).toContain("Inspect the durable result.");
  expect(secondInput).toContain("## Canonical compact replay for this phase");
  expect(secondInput).toContain("CANONICAL_COMPACT_RESULT");
  expect(requests[1]?.previous_response_id).toBeUndefined();
});

test("OpenAI stateless rebuild preserves assistant correction context", async () => {
  const { modelRound, requests } = openAIModelRound([{
    id: "compact-correction-response",
    model: "gpt-5.5",
    output: [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Correction retained." }],
    }],
  }]);

  await modelRound.runRound({
    model: "openai/gpt-5.5",
    messages: [
      { role: "user", content: "Original request" },
      { role: "assistant", content: "Do not lose this correction." },
      { role: "user", content: "Canonical compact projection" },
    ],
    tools: [],
  });

  const input = requests[0]?.input as Array<Record<string, unknown>>;
  expect(input.map((item) => item.role)).toEqual([
    "user",
    "assistant",
    "user",
  ]);
  expect(JSON.stringify(input)).toContain("Do not lose this correction.");
  expect(JSON.stringify(input)).toContain("Canonical compact projection");
});

test("OpenAI loop reset carries canonical replay and assistant correction in one fetch body", async () => {
  const continuityTool = { ...previewTool, name: "replace_phase_continuity" };
  const sourceTool = { ...previewTool, name: "read_file" };
  const { modelRound, requests } = openAIModelRound([
    {
      id: "combined-replay-response-1",
      model: "gpt-5.5",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{
            type: "output_text",
            text: "Correction: inspect the retained durable result.",
          }],
        },
        {
          type: "function_call",
          call_id: "combined-continuity",
          name: "replace_phase_continuity",
          arguments: "{}",
        },
        {
          type: "function_call",
          call_id: "combined-source",
          name: "read_file",
          arguments: "{}",
        },
      ],
    },
    {
      id: "combined-replay-response-2",
      model: "gpt-5.5",
      output: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Combined context received." }],
      }],
    },
  ]);

  const result = await runBtccAgentLoop({
    prompt: "Preserve the correction and replay exactly.",
    model: "openai/gpt-5.5",
    tools: [continuityTool, sourceTool],
    compactReplay: { enabled: true, initialPhaseContinuity: null },
    modelRound,
    executeTool: async (call) => call.name === "replace_phase_continuity"
      ? createBtccToolExecutionEnvelope(
          { ok: true },
          { kind: "phase_continuity", value: { objective: "corrected" } },
        )
      : createBtccToolExecutionEnvelope(
          { ok: true, content: "COMBINED_CANONICAL_RESULT" },
          {
            kind: "source",
            identity: {
              kind: "direct",
              result_ref: `guided-result-${"c".repeat(64)}`,
              revision: null,
              tool_name: "read_file",
              status: "completed",
              result_sha256: null,
              outcome: "succeeded",
              completeness: "complete",
            },
          },
        ),
  });

  expect(result.finalText).toBe("Combined context received.");
  expect(requests).toHaveLength(2);
  expect(requests[1]?.previous_response_id).toBeUndefined();
  const secondInput = JSON.stringify(requests[1]?.input);
  expect(secondInput).toContain(
    "Correction: inspect the retained durable result.",
  );
  expect(secondInput).toContain("## Canonical compact replay for this phase");
  expect(secondInput).toContain("COMBINED_CANONICAL_RESULT");
});

test("BTCC-created preview messages reach the actual OpenAI model-round boundary as image input", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-tool-image-"));
  const relativePath =
    "artifacts/generated/page-preview-11111111-1111-4111-8111-111111111111/desktop-top.jpg";
  const artifactPath = join(butlerData, relativePath);
  mkdirSync(join(artifactPath, ".."), { recursive: true });
  writeFileSync(artifactPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  try {
    const { modelRound, requests } = openAIModelRound([
      {
        id: "response-1",
        model: "gpt-5.5",
        output: [{
          type: "function_call",
          call_id: "call-preview",
          name: "inspect_workspace_page",
          arguments: "{}",
        }],
      },
      {
        id: "response-2",
        model: "gpt-5.5",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Preview inspected." }],
        }],
      },
    ]);

    const result = await runBtccAgentLoop({
      prompt: "Inspect the workspace page.",
      model: "openai/gpt-5.5",
      tools: [previewTool],
      butlerData,
      modelRound,
      executeTool: async () => previewOutput(relativePath),
    });

    expect(result.finalText).toBe("Preview inspected.");
    expect(requests).toHaveLength(2);
    const continuationInput = requests[1]?.input as Array<Record<string, unknown>>;
    const toolOutput = continuationInput.find((item) =>
      item.type === "function_call_output"
    );
    expect(toolOutput).toMatchObject({
      type: "function_call_output",
      call_id: "call-preview",
      output: [
        { type: "input_text" },
        {
          type: "input_image",
          image_url: "data:image/jpeg;base64,/9j/2Q==",
          detail: "high",
        },
      ],
    });
    expect(JSON.stringify(toolOutput)).not.toContain("model_image_attachments");
    expect(JSON.stringify(requests[1]?.__butler_codex_stateless_input) ?? "")
      .not.toContain("input_image");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("non-preview BTCC tool results cannot smuggle image attachments through the OpenAI round", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-tool-image-non-preview-"));
  const relativePath =
    "artifacts/generated/page-preview-11111111-1111-4111-8111-111111111111/desktop-top.jpg";
  const artifactPath = join(butlerData, relativePath);
  mkdirSync(join(artifactPath, ".."), { recursive: true });
  writeFileSync(artifactPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  try {
    const { modelRound, requests } = openAIModelRound([
      {
        id: "response-1",
        model: "gpt-5.5",
        output: [{
          type: "function_call",
          call_id: "call-command",
          name: "execute_command",
          arguments: "{}",
        }],
      },
      {
        id: "response-2",
        model: "gpt-5.5",
        output_text: "Command result observed.",
        output: [],
      },
    ]);
    const commandTool: BtccAgentLoopToolDefinition = {
      ...previewTool,
      name: "execute_command",
    };

    const result = await runBtccAgentLoop({
      prompt: "Run the command.",
      model: "openai/gpt-5.5",
      tools: [commandTool],
      butlerData,
      modelRound,
      executeTool: async () => previewOutput(relativePath),
    });

    expect(result.finalText).toBe("Command result observed.");
    const continuationInput = requests[1]?.input as Array<Record<string, unknown>>;
    const toolOutput = continuationInput.find((item) =>
      item.type === "function_call_output"
    );
    expect(toolOutput?.output).toBeString();
    expect(JSON.stringify(toolOutput)).not.toContain("input_image");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("preview image attachments cannot cross the generated-artifact symlink boundary through OpenAI", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-tool-image-link-"));
  const relativePath =
    "artifacts/generated/page-preview-11111111-1111-4111-8111-111111111111/desktop-top.jpg";
  const artifactPath = join(butlerData, relativePath);
  const outsidePath = join(butlerData, "outside.jpg");
  mkdirSync(join(artifactPath, ".."), { recursive: true });
  writeFileSync(outsidePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  symlinkSync(outsidePath, artifactPath);
  try {
    const { modelRound, requests } = openAIModelRound([
      {
        id: "response-1",
        model: "gpt-5.5",
        output: [{
          type: "function_call",
          call_id: "call-preview-link",
          name: "inspect_workspace_page",
          arguments: "{}",
        }],
      },
      {
        id: "response-2",
        model: "gpt-5.5",
        output_text: "Preview path rejected.",
        output: [],
      },
    ]);

    const result = await runBtccAgentLoop({
      prompt: "Inspect the linked preview.",
      model: "openai/gpt-5.5",
      tools: [previewTool],
      butlerData,
      modelRound,
      executeTool: async () => previewOutput(relativePath),
    });

    expect(result.finalText).toBe("Preview path rejected.");
    const continuationInput = requests[1]?.input as Array<Record<string, unknown>>;
    const toolOutput = continuationInput.find((item) =>
      item.type === "function_call_output"
    );
    expect(toolOutput?.output).toBeString();
    expect(JSON.stringify(toolOutput)).not.toContain("input_image");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});
