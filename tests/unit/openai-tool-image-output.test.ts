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

test("BTCC-created preview messages reach the actual OpenAI model-round boundary as image input", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-tool-image-"));
  const relativePath =
    "artifacts/generated/page-preview-11111111-1111-4111-8111-111111111111/desktop-top-model.jpg";
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
    "artifacts/generated/page-preview-11111111-1111-4111-8111-111111111111/desktop-top-model.jpg";
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
    "artifacts/generated/page-preview-11111111-1111-4111-8111-111111111111/desktop-top-model.jpg";
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
