import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAppAgentNativeServiceBridge,
  listNativeServiceProjections,
} from "../../packages/butler-app/client/electron/app-agent-native-service-bridge.mjs";
import { APP_MANAGED_RUNTIME_POINTER_SCHEMA } from "../../packages/butler-app/client/electron/app-managed-runtime.mjs";

test("App Agent native service bridge installs launchd service with App-managed env", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-native-bridge-launchd-"));
  try {
    const butlerData = join(tempDir, "data");
    const runtimeHome = writeAppManagedRuntime(butlerData, "9.9.9");
    const writes: Array<{ path: string; body: string }> = [];
    const commands: string[] = [];
    const bridge = createAppAgentNativeServiceBridge({
      butlerData,
      platform: "darwin",
      homeDir: "/Users/alice",
      getPort: () => 19123,
      prepareLocalAuth: () => ({
        filePath: join(butlerData, "app", "runtime", "auth", "local-agent-auth.json"),
      }),
      writeFile: (path, body) => writes.push({ path, body }),
      runCommand: (argv) => {
        commands.push(argv.join(" "));
        return { exitCode: argv[1] === "bootout" ? 1 : 0 };
      },
    });

    await bridge.registration.install();

    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe("/Users/alice/Library/LaunchAgents/com.hexpy.butler.plist");
    expect(writes[0]?.body).toContain(runtimeHome);
    expect(writes[0]?.body).toContain("<key>BUTLER_BUN</key>");
    expect(writes[0]?.body).toContain("<key>BUTLER_APP_MANAGED_RUNTIME_HOME</key>");
    expect(writes[0]?.body).toContain("<key>BUTLER_APP_MANAGED_RUNTIME_POINTER</key>");
    expect(writes[0]?.body).toContain("<key>BUTLER_APP_SERVER_HOST</key>");
    expect(writes[0]?.body).toContain("<key>BUTLER_APP_LOCAL_AUTH_FILE</key>");
    expect(writes[0]?.body).toContain("<key>BUTLER_APP_LOCAL_AUTH_REQUIRED</key>");
    expect(writes[0]?.body).toContain("<key>BUTLER_APP_GATEWAY_PID_FILE</key>");
    expect(writes[0]?.body).toContain("<string>19123</string>");
    expect(commands[0]).toContain("launchctl bootout gui/");
    expect(commands[0]).toContain("/com.hexpy.butler");
    expect(commands[1]).toContain(
      "launchctl bootstrap gui/",
    );
    expect(commands[1]).toContain(
      "/Users/alice/Library/LaunchAgents/com.hexpy.butler.plist",
    );
    expect(commands[2]).toContain("launchctl kickstart -k gui/");
    expect(commands[2]).toContain("/com.hexpy.butler");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("App Agent native service bridge ensures App-managed runtime before registration", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-native-bridge-ensure-"));
  try {
    const butlerData = join(tempDir, "data");
    const calls: string[] = [];
    const bridge = createAppAgentNativeServiceBridge({
      butlerData,
      platform: "darwin",
      homeDir: "/Users/alice",
      getPort: () => 19123,
      ensureRuntimePointer: () => {
        calls.push("ensure-runtime-pointer");
        writeAppManagedRuntime(butlerData, "9.9.9");
        return {};
      },
      prepareLocalAuth: () => {
        calls.push("prepare-local-auth");
        return {
          filePath: join(butlerData, "app", "runtime", "auth", "local-agent-auth.json"),
        };
      },
      writeFile: () => calls.push("write-service-file"),
      runCommand: (argv) => {
        if (argv[1] === "bootout") calls.push("bootout");
        else calls.push(argv[1] === "bootstrap" ? "bootstrap" : "kickstart");
        return { exitCode: 0 };
      },
    });

    await bridge.registration.install();

    expect(calls).toEqual([
      "ensure-runtime-pointer",
      "prepare-local-auth",
      "write-service-file",
      "bootout",
      "bootstrap",
      "kickstart",
    ]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("App Agent native service bridge rolls back runtime activation on required command failure", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-native-bridge-rollback-"));
  try {
    const butlerData = join(tempDir, "data");
    const calls: string[] = [];
    writeAppManagedRuntime(butlerData, "9.9.9");
    const bridge = createAppAgentNativeServiceBridge({
      butlerData,
      platform: "linux",
      homeDir: "/home/alice",
      getPort: () => 19123,
      ensureRuntimePointer: () => ({
        rollbackActivation: () => calls.push("rollback"),
      }),
      prepareLocalAuth: () => ({
        filePath: join(butlerData, "app", "runtime", "auth", "local-agent-auth.json"),
      }),
      writeFile: () => calls.push("write"),
      runCommand: (argv) => {
        calls.push(argv.join(" "));
        return { exitCode: argv.includes("daemon-reload") ? 0 : 1 };
      },
    });

    await expect(bridge.registration.install()).rejects.toThrow(
      "App Agent service command failed",
    );
    expect(calls).toEqual([
      "write",
      "systemctl --user daemon-reload",
      "systemctl --user enable --now butler.service",
      "rollback",
    ]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("App Agent native service bridge rolls back runtime activation on invalid prepared runtime", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-native-bridge-invalid-runtime-"));
  try {
    const butlerData = join(tempDir, "data");
    const calls: string[] = [];
    const runtimeHomeLabel = join("app", "runtime", "agent", "versions", "9.9.9");
    const runtimeHome = join(butlerData, runtimeHomeLabel);
    mkdirSync(join(runtimeHome, "packages", "butler-agent", "scripts"), { recursive: true });
    mkdirSync(join(butlerData, "app", "runtime", "agent"), { recursive: true });
    writeFileSync(join(runtimeHome, "packages", "butler-agent", "scripts", "service-daemon.sh"), "");
    writeFileSync(
      join(butlerData, "app", "runtime", "agent", "current.json"),
      `${JSON.stringify({
        schema: APP_MANAGED_RUNTIME_POINTER_SCHEMA,
        product: "butler-app",
        gateway_profile: "electron",
        version: "9.9.9",
        runtime_home: runtimeHomeLabel,
      }, null, 2)}\n`,
    );
    const bridge = createAppAgentNativeServiceBridge({
      butlerData,
      platform: "linux",
      homeDir: "/home/alice",
      ensureRuntimePointer: () => ({
        rollbackActivation: () => calls.push("rollback"),
      }),
      prepareLocalAuth: () => ({
        filePath: join(butlerData, "app", "runtime", "auth", "local-agent-auth.json"),
      }),
      runCommand: () => {
        calls.push("run");
        return { exitCode: 0 };
      },
    });

    await expect(bridge.registration.install()).rejects.toThrow(
      "missing App-managed runtime executable",
    );
    expect(calls).toEqual(["rollback"]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("App Agent native service bridge stop does not activate runtime", async () => {
  const calls: string[] = [];
  const bridge = createAppAgentNativeServiceBridge({
    butlerData: "/tmp/butler-data",
    platform: "darwin",
    homeDir: "/Users/alice",
    ensureRuntimePointer: () => {
      calls.push("ensure-runtime-pointer");
    },
    runCommand: (argv) => {
      calls.push(argv.join(" "));
      return { exitCode: 0 };
    },
  });

  await bridge.nativeServices.stop();

  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("launchctl bootout gui/");
});

test("App Agent native service bridge installs systemd service with escaped env", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler app native bridge systemd-"));
  try {
    const butlerData = join(tempDir, "data");
    writeAppManagedRuntime(butlerData, "9.9.9");
    const writes: Array<{ path: string; body: string }> = [];
    const commands: string[] = [];
    const bridge = createAppAgentNativeServiceBridge({
      butlerData,
      platform: "linux",
      homeDir: "/home/alice",
      getPort: () => 19123,
      prepareLocalAuth: () => ({
        filePath: join(butlerData, "app", "runtime", "auth", "local-agent-auth.json"),
      }),
      writeFile: (path, body) => writes.push({ path, body }),
      runCommand: (argv) => {
        commands.push(argv.join(" "));
        return { exitCode: 0 };
      },
    });

    await bridge.registration.install();
    await bridge.nativeServices.stop();
    await bridge.nativeServices.start();

    expect(writes[0]?.path).toBe("/home/alice/.config/systemd/user/butler.service");
    expect(writes[0]?.body).toContain('WorkingDirectory="');
    expect(writes[0]?.body).toContain('ExecStart=/bin/bash "');
    expect(writes[0]?.body).toContain(
      'Environment=BUTLER_APP_MANAGED_RUNTIME_POINTER="',
    );
    expect(writes[0]?.body).toContain('Environment=BUTLER_APP_SERVER_HOST="127.0.0.1"');
    expect(writes[0]?.body).toContain('Environment=BUTLER_APP_LOCAL_AUTH_REQUIRED="1"');
    expect(writes[0]?.body).toContain('Environment=BUTLER_APP_GATEWAY_PID_FILE="off"');
    expect(writes[0]?.body).toContain('Environment=BUTLER_APP_SERVER_PORT="19123"');
    expect(commands).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable --now butler.service",
      "systemctl --user stop butler.service",
      "systemctl --user start butler.service",
    ]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("App Agent native service bridge lists native service projections", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-native-bridge-list-"));
  try {
    const butlerData = join(tempDir, "data");
    writeServiceState(butlerData, "butler-main", 41_001);
    writeServiceState(butlerData, "app-gateway", 41_002);

    const projections = listNativeServiceProjections({
      butlerData,
      isPidRunning: (pid) => pid === 41_002,
    });

    expect(projections.find((item) => item.serviceId === "butler-main")).toMatchObject({
      pid: 41_001,
      status: "stale",
    });
    expect(projections.find((item) => item.serviceId === "app-gateway")).toMatchObject({
      pid: 41_002,
      status: "online",
    });
    expect(projections.find((item) => item.serviceId === "embed-server")).toMatchObject({
      pid: null,
      status: "offline",
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function writeAppManagedRuntime(butlerData: string, version: string): string {
  const runtimeHomeLabel = join("app", "runtime", "agent", "versions", version);
  const runtimeHome = join(butlerData, runtimeHomeLabel);
  mkdirSync(join(runtimeHome, "packages", "butler-agent", "scripts"), { recursive: true });
  mkdirSync(
    join(runtimeHome, "packages", "butler-agent", "resources", "runtime", "bin"),
    { recursive: true },
  );
  mkdirSync(join(butlerData, "app", "runtime", "agent"), { recursive: true });
  writeFileSync(join(runtimeHome, "packages", "butler-agent", "scripts", "service-daemon.sh"), "");
  writeFileSync(
    join(runtimeHome, "packages", "butler-agent", "resources", "runtime", "bin", "bun"),
    "",
  );
  writeFileSync(
    join(butlerData, "app", "runtime", "agent", "current.json"),
    `${JSON.stringify({
      schema: APP_MANAGED_RUNTIME_POINTER_SCHEMA,
      product: "butler-app",
      gateway_profile: "electron",
      version,
      runtime_home: runtimeHomeLabel,
    }, null, 2)}\n`,
  );
  return runtimeHome;
}

function writeServiceState(butlerData: string, serviceId: string, pid: number): void {
  mkdirSync(join(butlerData, "state", "services"), { recursive: true });
  writeFileSync(
    join(butlerData, "state", "services", `${serviceId}.json`),
    `${JSON.stringify({
      version: 1,
      supervisor: "native-supervisor",
      serviceId,
      pid,
      startedAt: "2026-06-13T00:00:00.000Z",
      command: "cmd",
      args: [],
      cwd: butlerData,
      stdoutFile: join(butlerData, "logs", "out.log"),
      stderrFile: join(butlerData, "logs", "err.log"),
      restartPolicy: "watchdog",
    }, null, 2)}\n`,
  );
}
