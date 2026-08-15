import { expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createAppAgentNativeServiceBridge,
  listNativeServiceProjections,
  prepareAppManagedEmbedHealthPort,
  prepareAppManagedEmbedSocket,
} from "../../packages/butler-app/client/electron/app-agent-native-service-bridge.mjs";
import { APP_MANAGED_RUNTIME_POINTER_SCHEMA } from "../../packages/butler-app/client/electron/app-managed-runtime.mjs";

test("App-managed embed socket uses a private per-user directory", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-embed-socket-"));
  const uid = process.getuid?.();
  try {
    expect(uid).toBeNumber();
    const socketPath = prepareAppManagedEmbedSocket({
      butlerData: "/private/example/butler-data",
      platform: "darwin",
      socketRoot: tempDir,
      uid,
    });
    const ownerDir = dirname(socketPath);
    expect(socketPath).toMatch(/\/butler-\d+\/embed-[a-f0-9]{20}\.sock$/);
    expect(lstatSync(ownerDir).mode & 0o777).toBe(0o700);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("App-managed embed socket rejects a symlinked owner directory", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-embed-socket-symlink-"));
  const uid = process.getuid?.();
  try {
    expect(uid).toBeNumber();
    const target = join(tempDir, "target");
    mkdirSync(target);
    symlinkSync(target, join(tempDir, `butler-${uid}`));
    expect(() => prepareAppManagedEmbedSocket({
      butlerData: "/private/example/butler-data",
      platform: "darwin",
      socketRoot: tempDir,
      uid,
    })).toThrow("unsafe App-managed embed socket directory");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("App-managed embed health port is stable, private, and separate from the gateway", () => {
  const first = prepareAppManagedEmbedHealthPort({
    butlerData: "/private/example/butler-data",
    gatewayPort: 19_123,
  });
  expect(first).toBe(prepareAppManagedEmbedHealthPort({
    butlerData: "/private/example/butler-data",
    gatewayPort: 19_123,
  }));
  expect(first).toBeGreaterThanOrEqual(40_000);
  expect(first).toBeLessThan(50_000);
  expect(first).not.toBe(19_123);
  expect(prepareAppManagedEmbedHealthPort({
    butlerData: "/private/another/butler-data",
    gatewayPort: 19_123,
  })).toBeGreaterThanOrEqual(40_000);
});

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
    expect(writes[0]?.body).toContain("<key>EMBED_SOCKET</key>");
    expect(writes[0]?.body).toMatch(/\/tmp\/butler-\d+\/embed-[a-f0-9]{20}\.sock/);
    expect(writes[0]?.body).toContain("<key>EMBED_HEALTH_PORT</key>");
    expect(writes[0]?.body).toContain(
      `<string>${prepareAppManagedEmbedHealthPort({ butlerData, gatewayPort: 19123 })}</string>`,
    );
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

test("App Agent native service bridge can isolate launchd service label for tests", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-native-bridge-launchd-test-label-"));
  try {
    const butlerData = join(tempDir, "data");
    writeAppManagedRuntime(butlerData, "9.9.9");
    const writes: Array<{ path: string; body: string }> = [];
    const commands: string[] = [];
    const bridge = createAppAgentNativeServiceBridge({
      butlerData,
      platform: "darwin",
      homeDir: "/Users/alice",
      serviceLabel: "com.hexpy.butler.test.local",
      getPort: () => 19124,
      getAppVersion: () => "2.3.4",
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
    await bridge.nativeServices.start();

    expect(writes[0]?.path).toBe(
      "/Users/alice/Library/LaunchAgents/com.hexpy.butler.test.local.plist",
    );
    expect(writes[0]?.body).toContain("<string>com.hexpy.butler.test.local</string>");
    expect(writes[0]?.body).toContain("<key>BUTLER_APP_VERSION</key>");
    expect(writes[0]?.body).toContain("<string>2.3.4</string>");
    expect(writes[1]?.body).toContain("<key>BUTLER_APP_VERSION</key>");
    expect(writes[1]?.body).toContain("<string>2.3.4</string>");
    expect(commands[0]).toContain("/com.hexpy.butler.test.local");
    expect(commands[1]).toContain(
      "/Users/alice/Library/LaunchAgents/com.hexpy.butler.test.local.plist",
    );
    expect(commands[2]).toContain("/com.hexpy.butler.test.local");
    expect(commands[3]).toContain("/com.hexpy.butler.test.local");
    expect(commands[4]).toContain(
      "/Users/alice/Library/LaunchAgents/com.hexpy.butler.test.local.plist",
    );
    expect(commands[5]).toContain("/com.hexpy.butler.test.local");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("App Agent native service bridge starts macOS menu bar helper with Agent service", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-native-bridge-helper-"));
  try {
    const butlerData = join(tempDir, "data");
    writeAppManagedRuntime(butlerData, "9.9.9");
    const writes: Array<{ path: string; body: string }> = [];
    const commands: string[] = [];
    const bridge = createAppAgentNativeServiceBridge({
      butlerData,
      platform: "darwin",
      homeDir: "/Users/alice",
      serviceLabel: "com.hexpy.butler.test.local",
      getPort: () => 19125,
      prepareLocalAuth: () => ({
        filePath: join(butlerData, "app", "runtime", "auth", "local-agent-auth.json"),
      }),
      menuBarHelper: {
        appBundlePath: "/Applications/Butler.app",
        executablePath:
          "/Applications/Butler.app/Contents/Library/LoginItems/Butler Menu Bar Helper.app/Contents/MacOS/Butler Menu Bar Helper",
        mainExecutablePath: "/Applications/Butler.app/Contents/MacOS/Butler",
      },
      writeFile: (path, body) => writes.push({ path, body }),
      runCommand: (argv) => {
        commands.push(argv.join(" "));
        return { exitCode: argv[1] === "bootout" ? 1 : 0 };
      },
    });

    await bridge.registration.install();

    expect(writes).toHaveLength(2);
    expect(writes[0]?.path).toBe(
      "/Users/alice/Library/LaunchAgents/com.hexpy.butler.test.local.plist",
    );
    expect(writes[1]?.path).toBe(
      "/Users/alice/Library/LaunchAgents/com.hexpy.butler.test.local.menubar-helper.plist",
    );
    expect(writes[1]?.body).toContain(
      "<string>com.hexpy.butler.test.local.menubar-helper</string>",
    );
    expect(writes[1]?.body).toContain("Butler Menu Bar Helper");
    expect(writes[1]?.body).toContain("<key>BUTLER_APP_AGENT_SERVICE_LABEL</key>");
    expect(writes[1]?.body).toContain("<string>com.hexpy.butler.test.local</string>");
    expect(writes[1]?.body).not.toContain("<key>BUTLER_APP_MENU_BAR_HELPER</key>");
    expect(writes[1]?.body).toContain("<key>BUTLER_APP_MENU_BAR_HELPER_PID_FILE</key>");
    expect(writes[1]?.body).toContain("/app/runtime/menu-bar-helper.pid");
    expect(writes[1]?.body).toContain("<key>BUTLER_APP_SERVER_URL</key>");
    expect(writes[1]?.body).toContain("<string>http://127.0.0.1:19125/</string>");
    expect(writes[1]?.body).not.toContain("<key>KeepAlive</key>");
    expect(commands).toEqual([
      "launchctl bootout gui/501/com.hexpy.butler.test.local",
      "launchctl bootstrap gui/501 /Users/alice/Library/LaunchAgents/com.hexpy.butler.test.local.plist",
      "launchctl kickstart -k gui/501/com.hexpy.butler.test.local",
      "launchctl bootout gui/501/com.hexpy.butler.test.local.menubar-helper",
      "launchctl bootstrap gui/501 /Users/alice/Library/LaunchAgents/com.hexpy.butler.test.local.menubar-helper.plist",
      "launchctl kickstart -k gui/501/com.hexpy.butler.test.local.menubar-helper",
    ]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("App Agent native service bridge does not restart menu bar helper on Agent start", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-native-bridge-helper-start-"));
  try {
    const butlerData = join(tempDir, "data");
    writeAppManagedRuntime(butlerData, "9.9.9");
    mkdirSync(join(butlerData, "app", "runtime"), { recursive: true });
    writeFileSync(join(butlerData, "app", "runtime", "menu-bar-helper.pid"), "4242\n");
    const writes: Array<{ path: string; body: string }> = [];
    const commands: string[] = [];
    const bridge = createAppAgentNativeServiceBridge({
      butlerData,
      platform: "darwin",
      homeDir: "/Users/alice",
      serviceLabel: "com.hexpy.butler.test.local",
      getPort: () => 19125,
      prepareLocalAuth: () => ({
        filePath: join(butlerData, "app", "runtime", "auth", "local-agent-auth.json"),
      }),
      menuBarHelper: {
        appBundlePath: "/Applications/Butler.app",
        executablePath:
          "/Applications/Butler.app/Contents/Library/LoginItems/Butler Menu Bar Helper.app/Contents/MacOS/Butler Menu Bar Helper",
        mainExecutablePath: "/Applications/Butler.app/Contents/MacOS/Butler",
      },
      writeFile: (path, body) => writes.push({ path, body }),
      isPidRunning: (pid) => pid === 4242,
      runCommand: (argv) => {
        commands.push(argv.join(" "));
        return { exitCode: argv[1] === "bootout" ? 1 : 0 };
      },
    });

    await bridge.nativeServices.start();

    expect(writes).toHaveLength(2);
    expect(writes[0]?.path).toBe(
      "/Users/alice/Library/LaunchAgents/com.hexpy.butler.test.local.plist",
    );
    expect(writes[1]?.path).toBe(
      "/Users/alice/Library/LaunchAgents/com.hexpy.butler.test.local.menubar-helper.plist",
    );
    expect(commands).toEqual([
      "launchctl bootout gui/501/com.hexpy.butler.test.local",
      "launchctl bootstrap gui/501 /Users/alice/Library/LaunchAgents/com.hexpy.butler.test.local.plist",
      "launchctl kickstart -k gui/501/com.hexpy.butler.test.local",
    ]);
    expect(commands.join("\n")).not.toContain("menubar-helper");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("App Agent native service bridge ensures missing menu bar helper on Agent start", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-native-bridge-helper-ensure-"));
  try {
    const butlerData = join(tempDir, "data");
    writeAppManagedRuntime(butlerData, "9.9.9");
    const writes: Array<{ path: string; body: string }> = [];
    const commands: string[] = [];
    const bridge = createAppAgentNativeServiceBridge({
      butlerData,
      platform: "darwin",
      homeDir: "/Users/alice",
      serviceLabel: "com.hexpy.butler.test.local",
      getPort: () => 19125,
      prepareLocalAuth: () => ({
        filePath: join(butlerData, "app", "runtime", "auth", "local-agent-auth.json"),
      }),
      menuBarHelper: {
        appBundlePath: "/Applications/Butler.app",
        executablePath:
          "/Applications/Butler.app/Contents/Library/LoginItems/Butler Menu Bar Helper.app/Contents/MacOS/Butler Menu Bar Helper",
        mainExecutablePath: "/Applications/Butler.app/Contents/MacOS/Butler",
      },
      writeFile: (path, body) => writes.push({ path, body }),
      runCommand: (argv) => {
        commands.push(argv.join(" "));
        return { exitCode: argv[1] === "bootout" ? 1 : 0 };
      },
    });

    await bridge.nativeServices.start();

    expect(writes).toHaveLength(2);
    expect(commands).toEqual([
      "launchctl bootout gui/501/com.hexpy.butler.test.local",
      "launchctl bootstrap gui/501 /Users/alice/Library/LaunchAgents/com.hexpy.butler.test.local.plist",
      "launchctl kickstart -k gui/501/com.hexpy.butler.test.local",
      "launchctl bootstrap gui/501 /Users/alice/Library/LaunchAgents/com.hexpy.butler.test.local.menubar-helper.plist",
      "launchctl kickstart gui/501/com.hexpy.butler.test.local.menubar-helper",
    ]);
    expect(commands.join("\n")).not.toContain(
      "launchctl bootout gui/501/com.hexpy.butler.test.local.menubar-helper",
    );
    expect(commands.join("\n")).not.toContain(
      "launchctl kickstart -k gui/501/com.hexpy.butler.test.local.menubar-helper",
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("App Agent native service bridge does not fail Agent install when menu bar helper bootstrap fails", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-native-helper-optional-"));
  try {
    const butlerData = join(tempDir, "data");
    writeAppManagedRuntime(butlerData, "9.9.9");
    const commands: string[] = [];
    const bridge = createAppAgentNativeServiceBridge({
      butlerData,
      platform: "darwin",
      homeDir: "/Users/alice",
      serviceLabel: "com.hexpy.butler.test.local",
      getPort: () => 19125,
      prepareLocalAuth: () => ({
        filePath: join(butlerData, "app", "runtime", "auth", "local-agent-auth.json"),
      }),
      menuBarHelper: {
        appBundlePath: "/Applications/Butler.app",
        executablePath:
          "/Applications/Butler.app/Contents/Library/LoginItems/Butler Menu Bar Helper.app/Contents/MacOS/Butler Menu Bar Helper",
        mainExecutablePath: "/Applications/Butler.app/Contents/MacOS/Butler",
      },
      writeFile: () => {},
      runCommand: (argv) => {
        const command = argv.join(" ");
        commands.push(command);
        if (command.includes("menubar-helper.plist")) return { exitCode: 5 };
        return { exitCode: argv[1] === "bootout" ? 1 : 0 };
      },
    });

    await expect(bridge.registration.install()).resolves.toBeUndefined();
    expect(commands).toContain(
      "launchctl kickstart -k gui/501/com.hexpy.butler.test.local",
    );
    expect(commands).toContain(
      "launchctl bootstrap gui/501 /Users/alice/Library/LaunchAgents/com.hexpy.butler.test.local.menubar-helper.plist",
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("App Agent native service bridge clears previous Agent children before relaunch", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-native-bridge-relaunch-"));
  try {
    const butlerData = join(tempDir, "data");
    writeAppManagedRuntime(butlerData, "9.9.9");
    writeServiceState(butlerData, "embed-server", 51_001);
    writeServiceState(butlerData, "app-gateway", 51_002);
    const online = new Set([51_001, 51_002]);
    const killed: number[] = [];
    const commands: string[] = [];
    const bridge = createAppAgentNativeServiceBridge({
      butlerData,
      platform: "darwin",
      homeDir: "/Users/alice",
      getPort: () => 19125,
      prepareLocalAuth: () => ({
        filePath: join(butlerData, "app", "runtime", "auth", "local-agent-auth.json"),
      }),
      isPidRunning: (pid) => online.has(pid),
      killPid: (pid) => {
        killed.push(pid);
        online.delete(Math.abs(pid));
      },
      sleepMs: async () => undefined,
      writeFile: () => {},
      runCommand: (argv) => {
        commands.push(argv.join(" "));
        return { exitCode: argv[1] === "bootout" ? 1 : 0 };
      },
    });

    await bridge.nativeServices.start();

    expect(commands[0]).toContain("launchctl bootout gui/");
    expect(killed).toEqual([-51_002, -51_001]);
    expect(commands[1]).toContain("launchctl bootstrap gui/");
    expect(commands[2]).toContain("launchctl kickstart -k gui/");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("App Agent native service bridge waits for process groups and gateway port before relaunch", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-native-bridge-port-release-"));
  try {
    const butlerData = join(tempDir, "data");
    writeAppManagedRuntime(butlerData, "9.9.9");
    writeServiceState(butlerData, "app-gateway", 52_002);
    const processGroups = new Set([52_002]);
    let portChecks = 0;
    const events: string[] = [];
    const bridge = createAppAgentNativeServiceBridge({
      butlerData,
      platform: "darwin",
      homeDir: "/Users/alice",
      getPort: () => 19125,
      prepareLocalAuth: () => ({
        filePath: join(butlerData, "app", "runtime", "auth", "local-agent-auth.json"),
      }),
      isPidRunning: () => false,
      isProcessGroupRunning: (pid) => processGroups.has(pid),
      isPortAvailable: async (port) => {
        events.push(`port:${port}:${portChecks}`);
        portChecks += 1;
        return portChecks > 1;
      },
      killPid: (pid) => {
        events.push(`kill:${pid}`);
        processGroups.delete(Math.abs(pid));
      },
      sleepMs: async () => undefined,
      writeFile: () => {},
      runCommand: (argv) => {
        events.push(argv.join(" "));
        return { exitCode: argv[1] === "bootout" ? 1 : 0 };
      },
    });

    await bridge.nativeServices.start();

    expect(events).toEqual([
      "launchctl bootout gui/501/com.hexpy.butler",
      "kill:-52002",
      "port:19125:0",
      "port:19125:1",
      "launchctl bootstrap gui/501 /Users/alice/Library/LaunchAgents/com.hexpy.butler.plist",
      "launchctl kickstart -k gui/501/com.hexpy.butler",
    ]);
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
    expect(writes[0]?.body).toContain("WorkingDirectory=");
    expect(writes[0]?.body).not.toContain('WorkingDirectory="');
    expect(writes[0]?.body).toContain("butler\\x20app\\x20native\\x20bridge\\x20systemd-");
    expect(writes[0]?.body).toContain('ExecStart=/bin/bash "');
    expect(writes[0]?.body).toContain(
      'Environment=BUTLER_APP_MANAGED_RUNTIME_POINTER="',
    );
    expect(writes[0]?.body).toContain('Environment=BUTLER_APP_SERVER_HOST="127.0.0.1"');
    expect(writes[0]?.body).toContain('Environment=BUTLER_APP_LOCAL_AUTH_REQUIRED="1"');
    expect(writes[0]?.body).toContain('Environment=BUTLER_APP_GATEWAY_PID_FILE="off"');
    expect(writes[0]?.body).toContain('Environment=BUTLER_APP_SERVER_PORT="19123"');
    expect(writes[0]?.body).toContain('Environment=EMBED_SOCKET="');
    expect(writes[0]?.body).toMatch(/Environment=EMBED_SOCKET="\/tmp\/butler-\d+\/embed-[a-f0-9]{20}\.sock"/);
    expect(writes[0]?.body).toContain(
      `Environment=EMBED_HEALTH_PORT="${prepareAppManagedEmbedHealthPort({ butlerData, gatewayPort: 19123 })}"`,
    );
    expect(writes[1]?.body).toContain('Environment=BUTLER_APP_SERVER_PORT="19123"');
    expect(commands).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable --now butler.service",
      "systemctl --user stop butler.service",
      "systemctl --user daemon-reload",
      "systemctl --user start butler.service",
    ]);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("App Agent native service bridge can isolate systemd unit for tests", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "butler-app-native-bridge-systemd-test-unit-"));
  try {
    const butlerData = join(tempDir, "data");
    writeAppManagedRuntime(butlerData, "9.9.9");
    const writes: Array<{ path: string; body: string }> = [];
    const commands: string[] = [];
    const bridge = createAppAgentNativeServiceBridge({
      butlerData,
      platform: "linux",
      homeDir: "/home/alice",
      systemdUnit: "butler-test-local.service",
      getPort: () => 19124,
      getAppVersion: () => "2.3.4",
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

    expect(writes[0]?.path).toBe("/home/alice/.config/systemd/user/butler-test-local.service");
    expect(writes[0]?.body).toContain('Environment=BUTLER_APP_VERSION="2.3.4"');
    expect(writes[1]?.path).toBe("/home/alice/.config/systemd/user/butler-test-local.service");
    expect(writes[1]?.body).toContain('Environment=BUTLER_APP_VERSION="2.3.4"');
    expect(commands).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable --now butler-test-local.service",
      "systemctl --user stop butler-test-local.service",
      "systemctl --user daemon-reload",
      "systemctl --user start butler-test-local.service",
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
