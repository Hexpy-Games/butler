import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createButlerToolExecutor } from
  "../../packages/butler-agent/src/agent/tools/butler-tools.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Butler actual tool execution boundary", () => {
  test("direct and tool_call inner native calls cross the same boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "butler-tool-boundary-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const data = join(root, "data");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "fact.txt"), "durable fact\n");
    const calls: string[] = [];
    const execute = createButlerToolExecutor({
      butlerHome: root,
      butlerData: data,
      workspacePath: workspace,
      currentToolNames: ["tool_call", "read_file"],
      describedToolIds: ["native:read_file"],
      async executionBoundary({ call, execute: dispatch }) {
        calls.push(call.name);
        return dispatch();
      },
    });

    const direct = await execute({
      name: "read_file",
      args: { path: "fact.txt" },
      rawArguments: JSON.stringify({ path: "fact.txt" }),
    });
    expect(direct).toMatchObject({ ok: true });

    const bridged = await execute({
      name: "tool_call",
      args: {
        id: "native:read_file",
        arguments: { path: "fact.txt" },
      },
      rawArguments: JSON.stringify({
        id: "native:read_file",
        arguments: { path: "fact.txt" },
      }),
    });
    expect(bridged).toMatchObject({ ok: true });
    expect(calls).toEqual(["read_file", "tool_call", "read_file"]);
  });
});
