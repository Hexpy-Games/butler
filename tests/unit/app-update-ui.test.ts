import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import {
  bundledAgentVersionLabel,
  UPDATE_COMPONENTS,
} from "../../packages/butler-app/client/ui/src/components/settings/updateComponentDisplay.ts";
import type { ComponentUpdateStatus } from "../../packages/butler-app/client/ui/src/app/types.ts";

test("App update UI exposes one public App action with bundled Agent detail", () => {
  expect(UPDATE_COMPONENTS).toEqual(["app"]);

  const appStatus = {
    component: "app",
    current_version: "1.0.0",
    available_version: "1.1.0",
    update_available: true,
    bundled_agent_version: "2.0.0",
  } as ComponentUpdateStatus;
  const serviceStatus = {
    component: "service",
    current_version: "2.0.0",
    available_version: "2.1.0",
    update_available: true,
  } as ComponentUpdateStatus;

  expect(bundledAgentVersionLabel(appStatus)).toBe("Butler Agent 2.0.0");
  expect(bundledAgentVersionLabel(serviceStatus)).toBe(null);
});

test("App bootstrap checks only the public App update path", () => {
  const source = readFileSync(
    join(
      import.meta.dir,
      "../../packages/butler-app/client/ui/src/hooks/useAppBootstrap.ts",
    ),
    "utf8",
  );
  const updateCheckStart = source.indexOf('api("/updates/check"');
  const updateCheckEnd = source.indexOf("}).catch(() => undefined)", updateCheckStart);
  const updateCheck = source.slice(updateCheckStart, updateCheckEnd);

  expect(updateCheck).toContain('component: "app"');
  expect(updateCheck).not.toContain("JSON.stringify({})");
});

test("Settings update panel surfaces update load, check, and apply failures", () => {
  const source = readFileSync(
    join(
      import.meta.dir,
      "../../packages/butler-app/client/ui/src/components/settings/UpdatesSettings.tsx",
    ),
    "utf8",
  );

  expect(source).toContain("notifyError");
  expect(source).toContain("copy.errors.loadUpdates");
  expect(source).toContain("copy.errors.checkUpdates");
  expect(source).toContain("copy.errors.applyUpdate");
});

test("Electron App update apply opens a staged App artifact", () => {
  const preload = readFileSync(
    join(
      import.meta.dir,
      "../../packages/butler-app/client/electron/preload.cjs",
    ),
    "utf8",
  );
  const main = readFileSync(
    join(
      import.meta.dir,
      "../../packages/butler-app/client/electron/main.mjs",
    ),
    "utf8",
  );

  expect(preload).toContain('ipcRenderer.invoke("butler:open-update-artifact"');
  expect(preload).toContain('result?.stage_status === "staged"');
  expect(main).toContain('lowerArtifactPath.endsWith(".msi")');
  expect(main).toContain('"System32", "msiexec.exe"');
  expect(main).toContain('["/i", artifactPath, "/qn", "/norestart"]');
  expect(preload).toContain("result?.artifact_path");
  expect(main).toContain('ipcMain.handle("butler:open-update-artifact"');
  expect(main).toContain("shell.openPath(artifactPath)");
  expect(main).toContain('resolve(butlerDataRoot, "updates", "artifacts")');
});
