import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import {
  DEFAULT_ISOLATED_DEV_SERVER_PORT,
  DEFAULT_ISOLATED_DEV_UI_PORT,
  isolatedDevEnvironment,
  resolveIsolatedDevConfig,
  runIsolatedDev,
} from "../../packages/butler-app/scripts/dev-butler.ts";

test("isolated dev runner composes isolated defaults and settles the gateway", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-isolated-dev-runner-"));
  try {
    const config = resolveIsolatedDevConfig({}, root);
    expect(config.dataRoot).toBe(join(root, ".dev-butler"));
    expect(config.serverPort).toBe(DEFAULT_ISOLATED_DEV_SERVER_PORT);
    expect(config.uiPort).toBe(DEFAULT_ISOLATED_DEV_UI_PORT);
    expect(config.electronUserDataDir).toBe(
      join(root, ".dev-butler", "app", "electron-user-data"),
    );

    const explicit = resolveIsolatedDevConfig({
      BUTLER_DATA: join(root, "normal-butler-data"),
      BUTLER_APP_SERVER_PORT: "18765",
      BUTLER_DEV_DATA: join(root, "explicit-dev-data"),
      BUTLER_DEV_SERVER_PORT: "29001",
    }, root);
    expect(explicit.dataRoot).toBe(join(root, "explicit-dev-data"));
    expect(explicit.serverPort).toBe(29_001);

    const environment = isolatedDevEnvironment(config, {});
    expect(environment.BUTLER_DATA).toBe(join(root, ".dev-butler"));
    expect(environment.BUTLER_APP_SERVER_PORT).toBe(
      String(DEFAULT_ISOLATED_DEV_SERVER_PORT),
    );
    expect(environment.BUTLER_APP_UI_PORT).toBe(String(DEFAULT_ISOLATED_DEV_UI_PORT));
    expect(environment.BUTLER_APP_ELECTRON_USER_DATA_DIR).toBe(
      join(root, ".dev-butler", "app", "electron-user-data"),
    );

    const spawned: Array<{ command: string; args: string[]; child: FakeChild }> = [];
    const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const result = await runIsolatedDev({
      cwd: root,
      env: {},
      dependencies: {
        platform: "linux",
        healthCheck: async () => true,
        sleep: async () => undefined,
        killProcessGroup: (pid, signal) => {
          killed.push({ pid, signal });
          spawned.find((entry) => entry.child.pid === pid)?.child.finish(0, signal);
        },
        spawnProcess: (command, args) => {
          const child = new FakeChild(spawned.length + 100);
          spawned.push({ command, args, child });
          if (args.includes("app:client:dev")) queueMicrotask(() => child.finish(0));
          return child as unknown as ChildProcess;
        },
      },
    });

    expect(result).toBe(0);
    expect(spawned.map(({ command, args }) => ({ command, args }))).toEqual([
      { command: "bun", args: ["run", "app:server"] },
      { command: "bun", args: ["run", "app:client:dev"] },
    ]);
    expect(killed).toEqual([{ pid: 100, signal: "SIGTERM" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  pid: number;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  kill(signal: NodeJS.Signals): boolean {
    this.finish(signal === "SIGKILL" ? 1 : 0, signal);
    return true;
  }

  finish(code: number, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}
