import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  inspectLegacyAppService,
  migrateLegacyAppService,
} from "../../packages/butler-app/client/electron/app-legacy-service-migration.mjs";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("legacy App service migration", () => {
  test("completes idempotently when no legacy service exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "butler-migration-"));
    roots.push(root);
    const result = await migrateLegacyAppService({
      butlerData: join(root, "data"),
      homeDir: join(root, "home"),
    });
    expect(result).toMatchObject({ status: "complete", detected_artifacts: [] });
  });

  test("detects only App-owned service state", () => {
    const root = mkdtempSync(join(tmpdir(), "butler-migration-"));
    roots.push(root);
    const data = join(root, "data");
    const stateDir = join(data, "state/services");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "app-gateway.json"), JSON.stringify({
      supervisor: "native-supervisor",
      processGroupId: 999,
      runtime: { managedBy: "butler-app" },
    }));
    writeFileSync(join(stateDir, "butler-main.json"), JSON.stringify({
      supervisor: "native-supervisor",
      processGroupId: 1000,
    }));
    const state = inspectLegacyAppService({ butlerData: data, homeDir: root });
    expect(state.serviceStates).toHaveLength(1);
    expect(state.serviceStates[0]?.processGroupId).toBe(999);
  });

  test("Cancel preserves legacy state and starts no cleanup", async () => {
    const root = mkdtempSync(join(tmpdir(), "butler-migration-"));
    roots.push(root);
    const data = join(root, "data");
    const plist = join(root, "legacy.plist");
    writeFileSync(plist, "legacy");
    let commands = 0;
    const result = await migrateLegacyAppService({
      butlerData: data,
      inspect: () => ({
        required: true,
        plists: [plist],
        pidFiles: [],
        serviceStates: [],
        detectedArtifacts: ["launch_agent"],
      }),
      activeWorkSnapshot: async () => ({ classification: "active_work_detected" }),
      confirm: async () => false,
      runCommand: async () => { commands += 1; },
    });
    expect(result.status).toBe("cancelled");
    expect(commands).toBe(0);
    expect(existsSync(plist)).toBeTrue();
  });

  test("confirmed migration stops verified groups and removes user artifacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "butler-migration-"));
    roots.push(root);
    const data = join(root, "data");
    const plist = join(root, "legacy.plist");
    const statePath = join(root, "service.json");
    writeFileSync(plist, "legacy");
    writeFileSync(statePath, "{}");
    const commands: string[] = [];
    const signals: string[] = [];
    let running = true;
    const result = await migrateLegacyAppService({
      butlerData: data,
      inspect: () => ({
        required: true,
        plists: [plist],
        pidFiles: [],
        serviceStates: [{ path: statePath, processGroupId: 999 }],
        detectedArtifacts: ["launch_agent", "app_service_state"],
      }),
      activeWorkSnapshot: async () => ({ classification: "active_work_unknown" }),
      confirm: async () => true,
      runCommand: async (_command, args) => { commands.push(args.join(" ")); },
      isProcessRunning: () => running,
      killProcessGroup: (_pgid, signal) => { signals.push(signal); running = false; },
    });
    expect(result.status).toBe("complete");
    expect(commands).toHaveLength(2);
    expect(signals).toEqual(["SIGTERM"]);
    expect(existsSync(plist)).toBeFalse();
    expect(existsSync(statePath)).toBeFalse();
    expect(JSON.parse(readFileSync(join(data, "app/runtime/foreground/legacy-migration.json"), "utf8")))
      .toMatchObject({ raw_text_included: false });
  });

  test("Linux migration disables and removes the legacy App-owned systemd unit", async () => {
    const root = mkdtempSync(join(tmpdir(), "butler-linux-migration-"));
    roots.push(root);
    const unit = join(root, "home", ".config", "systemd", "user", "butler.service");
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, "[Service]\n", "utf8");
    const commands: Array<{ command: string; args: string[] }> = [];

    const result = await migrateLegacyAppService({
      butlerData: join(root, "data"),
      homeDir: join(root, "home"),
      platform: "linux",
      activeWorkSnapshot: async () => ({ classification: "no_active_work" }),
      runCommand: async (command, args) => { commands.push({ command, args }); },
    });

    expect(result.status).toBe("complete");
    expect(commands).toEqual([{
      command: "systemctl",
      args: ["--user", "disable", "--now", "butler.service"],
    }]);
    expect(existsSync(unit)).toBe(false);
  });
});
