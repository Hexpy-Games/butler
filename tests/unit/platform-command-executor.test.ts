import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  PlatformCommandExecutor,
  createPlatformCommandExecutor,
} from "../../packages/butler-agent/src/runtime/command/platform-command-executor.ts";
import {
  runCommandExecutorConformance,
} from "../../packages/butler-agent/src/runtime/command/conformance.ts";
import type {
  CommandAdapter,
  CommandRequest,
  CommandResult,
} from "../../packages/butler-agent/src/runtime/command/contracts.ts";

const baseResult: CommandResult = {
  stdout: "",
  stderr: "",
  exitCode: 0,
  timedOut: false,
  cancelled: false,
  durationMs: 1,
  error: null,
};

describe("platform command executor", () => {
  test("keeps platform and dialect selection below the caller port", async () => {
    const selected: string[] = [];
    const adapter = (name: string): CommandAdapter => ({
      execute: async () => {
        selected.push(name);
        return { ...baseResult, stdout: name };
      },
    });
    const request: CommandRequest = {
      plan: {
        steps: [{
          executable: process.execPath,
          arguments: ["-e", "process.stdout.write('ok')"],
        }],
      },
    };

    const windows = new PlatformCommandExecutor({
      platform: "win32",
      posixAdapter: adapter("posix"),
      powerShellAdapter: adapter("powershell"),
    });
    const posix = new PlatformCommandExecutor({
      platform: "darwin",
      posixAdapter: adapter("posix"),
      powerShellAdapter: adapter("powershell"),
    });

    expect(await windows.execute(request)).toMatchObject({ stdout: "powershell" });
    expect(await posix.execute(request)).toMatchObject({ stdout: "posix" });
    expect(selected).toEqual(["powershell", "posix"]);
    expect(JSON.stringify(request)).not.toMatch(/win32|darwin|linux|posix|powershell|bash/iu);
  });

  test("passes the shared logical process conformance fixtures", async () => {
    const executor = createPlatformCommandExecutor();
    const report = await runCommandExecutorConformance(executor, process.execPath);

    expect(report).toEqual({
      stdout: true,
      stderr: true,
      exitCode: true,
      stdin: true,
      pipeline: true,
      cancellation: true,
      timeout: true,
      unicode: true,
      unicodeChunkBoundary: true,
      quoting: true,
      duration: true,
      forceTermination: true,
    });
  });

  test("rejects raw shell scripts and dialect selection at the caller contract", () => {
    const invalidRequest: CommandRequest = {
      // @ts-expect-error raw platform-specific scripts are infrastructure-only
      plan: { kind: "script", source: "Write-Output 'not-allowed'" },
    };

    expect(JSON.stringify(invalidRequest)).not.toContain("platform");
  });

  test("keeps shell and platform decisions out of the caller contract", () => {
    const runtimeRoot = join(
      process.cwd(),
      "packages",
      "butler-agent",
      "src",
      "runtime",
      "command",
    );
    const contracts = readFileSync(join(runtimeRoot, "contracts.ts"), "utf8");
    const runner = readFileSync(join(runtimeRoot, "node-command-runner.ts"), "utf8");
    const posix = readFileSync(join(runtimeRoot, "posix-command-adapter.ts"), "utf8");
    const windows = readFileSync(join(runtimeRoot, "powershell-command-adapter.ts"), "utf8");
    const selector = readFileSync(join(runtimeRoot, "platform-command-executor.ts"), "utf8");

    expect(contracts).not.toMatch(/platform|dialect|shell|bash|powershell/iu);
    expect(runner).toContain("shell: false");
    expect(posix).not.toMatch(/\/bin\/(?:ba)?sh|["']-(?:c|lc)["']/u);
    expect(windows).not.toMatch(/powershell\.exe|pwsh\.exe|["']-Command["']/iu);
    expect(selector).toContain('platform === "win32"');
  });
});
