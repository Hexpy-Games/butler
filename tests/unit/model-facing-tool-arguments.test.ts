import { expect, test } from "bun:test";
import { bindRuntimeOwnedWorkspaceArguments } from "../../packages/butler-agent/src/agent/turn/native/turn-runner/model-facing-tool-arguments.ts";

const workspace = "/private/var/tmp/butler/workspace";

test("runtime-owned workspace arguments canonicalize only the active root", () => {
  expect(bindRuntimeOwnedWorkspaceArguments({
    name: "write_file",
    args: {
      workspace_root: workspace,
      path: `${workspace}/src/a.ts`,
      content: "a",
      overwrite: false,
    },
  }, workspace)).toEqual({
    name: "write_file",
    args: { path: "src/a.ts", content: "a", overwrite: false },
  });

  expect(bindRuntimeOwnedWorkspaceArguments({
    name: "run_command",
    args: {
      command: "bun test",
      cwd: "/var/tmp/butler/workspace",
      output_paths: [
        "/var/tmp/butler/workspace/test-results.json",
        "/tmp/outside.json",
      ],
    },
  }, workspace)).toEqual({
    name: "run_command",
    args: {
      command: "bun test",
      cwd: ".",
      output_paths: ["test-results.json", "/tmp/outside.json"],
    },
  });
});
