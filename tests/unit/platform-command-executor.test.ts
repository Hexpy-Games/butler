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
import { runNodeCommand } from "../../packages/butler-agent/src/runtime/command/node-command-runner.ts";

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
  }, 60_000);

  test("settles after forced termination when close delivery is delayed", async () => {
    const signals: NodeJS.Signals[] = [];
    const result = await runNodeCommand(
      [{
        executable: process.execPath,
        arguments: ["-e", "setInterval(() => {}, 1000)"],
      }],
      {
        plan: {
          steps: [{ executable: process.execPath }],
        },
        timeoutMs: 10,
      },
      {
        detached: false,
        signal: (child, signal) => {
          signals.push(signal);
          if (signal === "SIGKILL") {
            setTimeout(() => child.kill("SIGKILL"), 750).unref?.();
          }
        },
      },
    );

    expect(result).toMatchObject({
      exitCode: null,
      timedOut: true,
      cancelled: false,
    });
    expect(result.durationMs).toBeLessThan(5_000);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }, 10_000);

  test("normalizes spawn failures without reflecting executable or environment secrets", async () => {
    const executableSecret = `missing-secret-executable-${process.pid}-${Date.now()}`;
    const environmentSecret = "environment-secret-must-not-leak";
    const result = await createPlatformCommandExecutor().execute({
      plan: { steps: [{ executable: executableSecret }] },
      environment: { PRIVATE_TEST_TOKEN: environmentSecret },
      inheritEnvironment: false,
    });

    expect(result).toMatchObject({
      exitCode: null,
      timedOut: false,
      cancelled: false,
      error: {
        code: "command_spawn_failed",
        message: "command process could not be started",
      },
    });
    expect(JSON.stringify(result)).not.toContain(executableSecret);
    expect(JSON.stringify(result)).not.toContain(environmentSecret);
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

  test("keeps App-reachable command callers free of platform and process dialect ownership", () => {
    const sources = [
      "packages/butler-agent/src/agent/tools/run-command/run_command/executor.ts",
      "packages/butler-agent/src/integrations/providers/worker/shell.ts",
      "packages/butler-agent/src/agent/tool-support/planned-worker-runtime.ts",
      "packages/butler-agent/src/agent/tool-support/background-worker-dispatch.ts",
      "packages/butler-agent/src/gateways/app/domain/workers/worker-control-store.ts",
    ];
    for (const path of sources) {
      const source = readFileSync(join(process.cwd(), path), "utf8");
      expect(source).not.toMatch(
        /\/bin\/bash|powershell(?:\.exe)?|pwsh(?:\.exe)?|dispatch\.sh|taskkill|process\.platform|process\.kill\(\s*-|\bspawn(?:Sync)?\s*\(/iu,
      );
    }

    const commandTool = readFileSync(
      join(
        process.cwd(),
        "packages/butler-agent/src/agent/tools/run-command/run_command/executor.ts",
      ),
      "utf8",
    );
    const workerProvider = readFileSync(
      join(
        process.cwd(),
        "packages/butler-agent/src/integrations/providers/worker/shell.ts",
      ),
      "utf8",
    );
    expect(commandTool).toContain("createPlatformCommandExecutor");
    expect(commandTool).toContain("executeLegacyCommandCompatibility");
    expect(workerProvider).toContain("createPlatformCommandExecutor");
    expect(workerProvider).toContain("executeLegacyCommandCompatibility");
  });
});
