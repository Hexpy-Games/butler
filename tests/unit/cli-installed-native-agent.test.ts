import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cliAgentHome,
  preferNewerAgent,
  resolveCliInstalledAgent,
  versionNewer,
} from "../../packages/butler-app/client/electron/cli-installed-native-agent.mjs";
import { resolveNativeAgentInstallation } from "../../packages/butler-app/client/electron/bundled-native-agent.mjs";

function installVersion(agentHome: string, version: string, manifest: Record<string, unknown> = {}) {
  const dir = join(agentHome, `${version}-abcd1234`);
  mkdirSync(join(dir, "resources"), { recursive: true });
  writeFileSync(join(dir, "butler-agent"), "#!/bin/sh\n");
  chmodSync(join(dir, "butler-agent"), 0o755);
  writeFileSync(
    join(dir, "native-agent-manifest.json"),
    JSON.stringify({
      schema: "butler.native-agent-install.v1",
      version,
      platform: process.platform,
      architecture: process.arch,
      ...manifest,
    }),
  );
  return dir;
}

function activate(agentHome: string, dir: string) {
  rmSync(join(agentHome, "current"), { force: true });
  symlinkSync(dir.slice(agentHome.length + 1), join(agentHome, "current"));
}

test("the CLI installation is used only when it is newer than the bundled Agent", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-cli-agent-"));
  try {
    const agentHome = join(root, "agent-home");
    const env = { BUTLER_AGENT_HOME: agentHome };
    const bundled = {
      command: "bundled",
      args: [],
      cwd: "/data",
      appManaged: true as const,
      bundledAgentVersion: "0.0.21",
      env: {},
    };

    expect(resolveCliInstalledAgent({ butlerData: "/data", env })).toBeNull();

    activate(agentHome, installVersion(agentHome, "0.0.20"));
    const older = resolveCliInstalledAgent({ butlerData: "/data", env });
    expect(older?.bundledAgentVersion).toBe("0.0.20");
    expect(preferNewerAgent(bundled, older)).toBe(bundled);

    activate(agentHome, installVersion(agentHome, "0.0.22"));
    const newer = resolveCliInstalledAgent({ butlerData: "/data", env });
    expect(newer?.command.endsWith("0.0.22-abcd1234/butler-agent")).toBe(true);
    expect(newer?.args.slice(0, 1)).toEqual(["--installation-root"]);
    expect(newer?.env).toEqual({ BUTLER_DATA: "/data" });
    expect(preferNewerAgent(bundled, newer)).toBe(newer as typeof bundled);

    activate(agentHome, installVersion(agentHome, "0.0.23", { architecture: "mips" }));
    expect(resolveCliInstalledAgent({ butlerData: "/data", env })).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the packaged App resolves the newer of its bundled and CLI-installed Agent", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-cli-agent-app-"));
  try {
    const resourcesPath = join(root, "app", "resources");
    const payload = join(resourcesPath, "bundled-agent");
    mkdirSync(join(payload, "bin"), { recursive: true });
    mkdirSync(join(payload, "resources"), { recursive: true });
    writeFileSync(join(payload, "bin", "butler-agent"), "#!/bin/sh\n");
    chmodSync(join(payload, "bin", "butler-agent"), 0o755);
    writeFileSync(join(payload, "native-agent-manifest.json"), JSON.stringify({ version: "0.0.21" }));
    const agentHome = join(root, "agent-home");
    const resolve = () => resolveNativeAgentInstallation({
      butlerData: join(root, "data"),
      resourcesPath,
      execPath: join(root, "app", "Butler"),
      platform: "linux",
      isPackaged: true,
      env: { BUTLER_AGENT_HOME: agentHome },
    });
    expect(resolve().bundledAgentVersion).toBe("0.0.21");
    activate(agentHome, installVersion(agentHome, "0.0.22", { platform: "linux" }));
    expect(resolve().bundledAgentVersion).toBe("0.0.22");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// test-category: pure-logic
test("versions compare by numeric segments and the home follows the OS convention", () => {
  expect(versionNewer("0.0.22", "0.0.21")).toBe(true);
  expect(versionNewer("0.0.21", "0.0.21")).toBe(false);
  expect(versionNewer("1.0.0", "0.9.9")).toBe(true);
  expect(cliAgentHome({ platform: "darwin", env: {}, home: "/h" })).toBe("/h/Applications/ButlerAgent");
  expect(cliAgentHome({ platform: "linux", env: {}, home: "/h" })).toBe("/h/.local/share/butler/agent");
  expect(cliAgentHome({ platform: "linux", env: { XDG_DATA_HOME: "/x" }, home: "/h" })).toBe("/x/butler/agent");
  expect(cliAgentHome({ platform: "win32", env: {}, home: "/h" })).toBeNull();
});
