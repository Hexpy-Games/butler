import { expect, test } from "bun:test";
import type { FunctionToolDefinition } from "../../packages/butler-agent/src/integrations/providers/provider.ts";
import { ToolSurfacePromptController } from "../../packages/butler-agent/src/agent/turn/tool-surface-prompt-controller.ts";

const toolDescribe = tool("tool_describe");
const toolCall = tool("tool_call");
const runCommand = tool("run_command");

test("tool surface prompt controller exposes selected tools only for the active prompt scope", async () => {
  const controller = new ToolSurfacePromptController({
    role: "butler",
    tools: [toolDescribe, toolCall, runCommand],
    providerSupportsSchemaPromotion: false,
  });

  expect(controller.currentToolNames()).toEqual([]);

  const activeNames = await controller.runWithSelectedSurface(async (surface) => {
    expect(surface.dynamicTools).toBeUndefined();
    return {
      selected: surface.tools.map((item) => item.name),
      current: controller.currentToolNames(),
    };
  });

  expect(activeNames.selected).toContain("tool_call");
  expect(activeNames.current).toEqual(activeNames.selected);
  expect(controller.currentToolNames()).toEqual([]);
});

test("tool surface prompt controller promotes described native tools into same-turn dynamic tools", async () => {
  const controller = new ToolSurfacePromptController({
    role: "butler",
    sessionMetadata: { requiredNativeTools: ["tool_describe", "tool_call"] },
    tools: [toolDescribe, toolCall, runCommand],
    providerSupportsSchemaPromotion: true,
  });

  const beforePromotion = await controller.runWithSelectedSurface(async (surface) =>
    surface.dynamicTools?.().map((item) => item.name) ?? [],
  );

  controller.recordToolDescriptionResult({
    descriptions: [{
      id: "run-command",
      call_affordance: {
        type: "native_tool",
        tool_name: "run_command",
      },
    }],
  });

  const afterPromotion = await controller.runWithSelectedSurface(async (surface) => ({
    describedIds: controller.describedToolIdList(),
    dynamicNames: surface.dynamicTools?.().map((item) => item.name) ?? [],
  }));

  expect(beforePromotion).not.toContain("run_command");
  expect(afterPromotion.describedIds).toEqual(["run-command"]);
  expect(afterPromotion.dynamicNames).toContain("run_command");
});

function tool(name: string): FunctionToolDefinition {
  return {
    type: "function",
    name,
    description: `${name} test tool`,
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  };
}
