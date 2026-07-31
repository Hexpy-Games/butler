import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentLoop } from
  "../../packages/butler-agent/src/agent/model-tool-loop/index.ts";
import { newToolMessages } from
  "../../packages/butler-agent/src/integrations/providers/shared/tools.ts";

test("OpenAI continuation receives tool-generated visual evidence as image input", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-tool-image-"));
  const artifactPath = join(
    butlerData,
    "artifacts",
    "generated",
    "page-preview-11111111-1111-4111-8111-111111111111",
    "desktop-top.jpg",
  );
  mkdirSync(join(artifactPath, ".."), { recursive: true });
  writeFileSync(artifactPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  try {
    let round = 0;
    const result = await runAgentLoop({
      messages: [{ role: "user", content: "Inspect the page" }],
      tools: [{
        name: "inspect_workspace_page",
        description: "Inspect a workspace page.",
      }],
      callModel: async () => round++ === 0
        ? {
            toolCalls: [{
              id: "call-preview",
              name: "inspect_workspace_page",
              arguments: { entry_path: "index.html" },
            }],
          }
        : { text: "The page is visible." },
      executeTool: async () => ({
        ok: true,
        viewports: [{
          name: "desktop",
          screenshot_paths: [
            "artifacts/generated/page-preview-11111111-1111-4111-8111-111111111111/desktop-top.jpg",
          ],
        }],
        model_image_attachments: [{
          path: "artifacts/generated/page-preview-11111111-1111-4111-8111-111111111111/desktop-top.jpg",
          media_type: "image/jpeg",
          name: "desktop preview",
        }],
      }),
    });

    const continuation = newToolMessages(result.messages, 0, butlerData);
    expect(continuation.items).toHaveLength(1);
    expect(continuation.items[0]).toMatchObject({
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
    expect(JSON.stringify(continuation.items[0])).not.toContain(
      "model_image_attachments",
    );
    expect(continuation.statelessItems).toEqual([{
      type: "function_call_output",
      call_id: "call-preview",
      output: expect.stringContaining('"ok":true'),
    }]);
    expect(JSON.stringify(continuation.statelessItems)).not.toContain(
      "input_image",
    );
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("non-preview tools cannot smuggle image attachments into a continuation", async () => {
  const result = await toolImageLoop({
    toolName: "execute_command",
    artifactPath:
      "artifacts/generated/page-preview-11111111-1111-4111-8111-111111111111/desktop-top.jpg",
  });
  const continuation = newToolMessages(result.messages, 0);
  expect(continuation.items[0]?.output).toBeString();
  expect(JSON.stringify(continuation.items)).not.toContain("input_image");
});

test("preview image attachments cannot follow a symlink outside generated artifacts", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-tool-image-link-"));
  const relativePath =
    "artifacts/generated/page-preview-11111111-1111-4111-8111-111111111111/desktop-top.jpg";
  const artifactPath = join(butlerData, relativePath);
  const outsidePath = join(butlerData, "outside.jpg");
  mkdirSync(join(artifactPath, ".."), { recursive: true });
  writeFileSync(outsidePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  symlinkSync(outsidePath, artifactPath);
  try {
    const result = await toolImageLoop({
      toolName: "inspect_workspace_page",
      artifactPath: relativePath,
    });
    const continuation = newToolMessages(result.messages, 0, butlerData);
    expect(continuation.items[0]?.output).toBeString();
    expect(JSON.stringify(continuation.items)).not.toContain("input_image");
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

async function toolImageLoop(input: {
  toolName: string;
  artifactPath: string;
}) {
  let round = 0;
  return await runAgentLoop({
    messages: [{ role: "user", content: "Inspect the page" }],
    tools: [{ name: input.toolName, description: "Test tool." }],
    callModel: async () => round++ === 0
      ? {
          toolCalls: [{
            id: "call-preview",
            name: input.toolName,
            arguments: {},
          }],
        }
      : { text: "Done." },
    executeTool: async () => ({
      ok: true,
      model_image_attachments: [{
        path: input.artifactPath,
        media_type: "image/jpeg",
        name: "untrusted preview",
      }],
    }),
  });
}
