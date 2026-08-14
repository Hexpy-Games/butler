import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runBtccAgentLoop,
  type BtccAgentLoopToolDefinition,
} from "../../packages/butler-agent/src/agent/btcc/agent-loop/index.ts";
import {
  createTurnContinuationBudgetState,
  transitionTurnContinuationBudget,
  type TurnContinuationBudgetEvent,
} from "../../packages/butler-agent/src/agent/btcc/turn/index.ts";
import { createInspectWorkspacePageHandler } from
  "../../packages/butler-agent/src/agent/tools/workspace-page-preview/inspect_workspace_page/executor.ts";
import { runOpenAIModelRound } from
  "../../packages/butler-agent/src/integrations/providers/openai/model-round.ts";

const originalFetch = globalThis.fetch;
const originalBaseUrl = process.env.OPENAI_BASE_URL;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = originalBaseUrl;
});

const previewTool: BtccAgentLoopToolDefinition = {
  name: "inspect_workspace_page",
  description: "Inspect a workspace page.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      entry_path: { type: "string" },
    },
    required: ["entry_path"],
  },
};

test("direct preview keeps full artifacts while bounded model images reach the next M1 round", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-preview-budget-"));
  const workspace = join(butlerData, "workspace");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "index.html"), "<main>Preview</main>");
  const screenshot = (position: "top" | "bottom") => {
    const bytes = Buffer.alloc(60 * 1024, 0x61);
    bytes[0] = 0xff;
    bytes[1] = 0xd8;
    bytes[bytes.length - 2] = 0xff;
    bytes[bytes.length - 1] = 0xd9;
    const modelBytes = Buffer.alloc(20 * 1024, 0x62);
    modelBytes[0] = 0xff;
    modelBytes[1] = 0xd8;
    modelBytes[modelBytes.length - 2] = 0xff;
    modelBytes[modelBytes.length - 1] = 0xd9;
    return {
      position,
      media_type: "image/jpeg",
      base64: bytes.toString("base64"),
      ...(position === "top" ? { model_base64: modelBytes.toString("base64") } : {}),
    };
  };
  const preview = createInspectWorkspacePageHandler({
    butlerData,
    workspacePath: workspace,
    endpoint: "http://127.0.0.1:29991/v1/preview",
    authToken: "a".repeat(43),
    fetcher: (async () => Response.json({
      ok: true,
      viewports: ["desktop", "mobile"].map((name) => ({
        name,
        requested_width: name === "desktop" ? 1_440 : 390,
        requested_height: name === "desktop" ? 900 : 844,
        inner_width: name === "desktop" ? 1_440 : 390,
        client_width: name === "desktop" ? 1_440 : 390,
        scroll_width: name === "desktop" ? 1_440 : 390,
        scroll_height: 2_000,
        body_text_length: 100,
        hidden_text_elements: 0,
        horizontal_overflow: false,
        loaded: true,
        console_errors: [],
        blocked_external_requests: 0,
        screenshot_truncated: true,
        screenshots: [screenshot("top"), screenshot("bottom")],
        error: null,
      })),
    })) as unknown as typeof fetch,
  });

  const requests: Record<string, unknown>[] = [];
  process.env.OPENAI_BASE_URL = "https://example.test/v1";
  globalThis.fetch = (async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return requests.length === 1
      ? Response.json({
          id: "response-preview",
          model: "gpt-5.5",
          output: [{
            type: "function_call",
            call_id: "call-preview",
            name: "inspect_workspace_page",
            arguments: JSON.stringify({ entry_path: "index.html" }),
          }],
        })
      : Response.json({
          id: "response-final",
          model: "gpt-5.5",
          output: [{
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Preview inspected." }],
          }],
        });
  }) as typeof fetch;

  const limits = {
    maxModelRequests: 60,
    maxToolRounds: 60,
    maxModelFacingBytes: 192 * 1024,
    maxCumulativeModelFacingBytes: 8 * 1024 * 1024,
    maxOutputBytes: 512 * 1024,
    maxElapsedMs: 2 * 60 * 60 * 1_000,
    maxIdleMs: 20 * 60 * 1_000,
  };
  let nowMs = 1_000;
  let previewOutput: unknown;
  const continuationBudget = {
    state: createTurnContinuationBudgetState({ turnId: "turn", limits, nowMs }),
    async transition(event: TurnContinuationBudgetEvent) {
      nowMs += 1;
      this.state = transitionTurnContinuationBudget(this.state, event, nowMs);
    },
    async admitRequest(input: {
      roundId: string;
      requestDigest: string;
      modelFacingBytes: number;
    }) {
      await this.transition({ kind: "admit_request", ...input });
    },
    async recordOutput(input: { roundId: string; outputBytes: number }) {
      await this.transition({ kind: "record_output", ...input });
    },
    async recordToolRound(input: { roundId: string }) {
      await this.transition({ kind: "record_tool_round", ...input });
    },
  };

  try {
    const result = await runBtccAgentLoop({
      prompt: "Inspect the page.",
      model: "openai/gpt-5.5",
      tools: [previewTool],
      butlerData,
      continuationBudget,
      modelRound: {
        runRound: (request) => runOpenAIModelRound(request, {
          authorization: "Bearer test-key",
          mode: "api_key",
        }),
      },
      executeTool: async (call) => {
        const result = await preview({ args: call.arguments, signal: call.signal });
        previewOutput = result;
        return result;
      },
    });
    expect(result.finalText).toBe("Preview inspected.");
    expect(requests).toHaveLength(2);
    expect((previewOutput as Record<string, unknown>).model_image_attachments)
      .toHaveLength(2);
    expect(Buffer.byteLength(JSON.stringify(requests[1]), "utf8")).toBeLessThan(192 * 1024);
    expect(JSON.stringify(requests[1]).match(/input_image/gu)).toHaveLength(2);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});
