import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGuidedWorkspaceFileEffectAdapter,
  workspaceFileEffectTarget,
} from
  "../../packages/butler-agent/src/agent/composition/production-btcc/guided-workspace-file-effect.ts";
import { createButlerToolExecutor } from
  "../../packages/butler-agent/src/agent/tools/butler-tools.ts";
import { sha256Hex } from
  "../../packages/butler-agent/src/agent/tools/file-tools/shared/evidence.ts";

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

  test("runtime-prepared hashes reach the registered writer and reject a stale overwrite", async () => {
    const root = mkdtempSync(join(tmpdir(), "butler-tool-boundary-cas-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const data = join(root, "data");
    const targetPath = join(workspace, "report.txt");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(targetPath, "original\n");

    let preparedInput: Record<string, unknown> | undefined;
    const execute = createButlerToolExecutor({
      butlerHome: root,
      butlerData: data,
      workspacePath: workspace,
      async executionBoundary({ call, execute: dispatch }) {
        if (call.name !== "write_file") return dispatch();
        const adapter = createGuidedWorkspaceFileEffectAdapter({
          workspacePath: workspace,
          butlerData: data,
          async executeWriteFile(args) {
            preparedInput = args;
            writeFileSync(targetPath, "concurrent change\n");
            return dispatch({
              args,
              rawArguments: JSON.stringify(args),
            });
          },
        });
        const normalizedInput = adapter.normalizeInput(call.args);
        return adapter.dispatch({
          normalizedTarget: workspaceFileEffectTarget(normalizedInput.path),
          normalizedInput,
          idempotencyKey: "runtime-prepared-hash",
          signal: new AbortController().signal,
        });
      },
    });

    const result = await execute({
      name: "write_file",
      args: {
        path: "report.txt",
        content: "desired\n",
        overwrite: true,
      },
      rawArguments: JSON.stringify({
        path: "report.txt",
        content: "desired\n",
        overwrite: true,
      }),
    });

    expect(preparedInput).toMatchObject({
      path: "report.txt",
      expected_sha256: sha256Hex("original\n"),
    });
    expect(result).toMatchObject({
      status: "not_applied",
      error: { code: "expected_sha256_mismatch" },
    });
    expect(readFileSync(targetPath, "utf8")).toBe("concurrent change\n");
  });
});
