import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("Electron first-run setup bridge exposes status start cancel and diagnostics", () => {
  const preload = readRepoFile("packages/butler-app/client/electron/preload.cjs");
  const main = readRepoFile("packages/butler-app/client/electron/main.mjs");
  const setupBridge = readRepoFile(
    "packages/butler-app/client/electron/setup-bridge.mjs",
  );
  const api = readRepoFile("packages/butler-app/client/ui/src/app/api.ts");

  expect(preload).toContain("getSetupStatus");
  expect(preload).toContain("startSetup");
  expect(preload).toContain("cancelSetup");
  expect(preload).toContain("exportSetupDiagnostics");
  expect(preload).toContain("butler:first-run-setup-start");
  expect(preload).toContain("butler:first-run-setup-diagnostics");

  expect(main).toContain('ipcMain.handle("butler:first-run-setup-status"');
  expect(main).toContain('ipcMain.handle("butler:first-run-setup-start"');
  expect(main).toContain('ipcMain.handle("butler:first-run-setup-cancel"');
  expect(main).toContain('ipcMain.handle("butler:first-run-setup-diagnostics"');
  expect(main).toContain("createFirstRunSetupBridge");
  expect(setupBridge).toContain("createFirstRunSetupBridge");

  expect(api).toContain('url.pathname === "/setup/status"');
  expect(api).toContain('url.pathname === "/setup/start"');
  expect(api).toContain('url.pathname === "/setup/cancel"');
  expect(api).toContain('url.pathname === "/setup/diagnostics"');
});

test("first-run setup diagnostics are redacted coarse status only", () => {
  const setupBridge = readRepoFile(
    "packages/butler-app/client/electron/setup-bridge.mjs",
  );
  const diagnosticsStart = setupBridge.indexOf(
    "function diagnosticsView",
  );
  const diagnosticsEnd = setupBridge.indexOf(
    "function setupCheck",
    diagnosticsStart,
  );
  const diagnostics = setupBridge.slice(diagnosticsStart, diagnosticsEnd);

  expect(diagnostics).toContain("generated_at");
  expect(diagnostics).toContain("phase");
  expect(diagnostics).toContain("checks");
  expect(diagnostics).toContain("errors");
  expect(diagnostics).not.toContain("serverUrl");
  expect(diagnostics).not.toContain("butlerDataRoot");
  expect(diagnostics).not.toContain("process.env");
  expect(diagnostics).not.toContain("error.message");
  expect(diagnostics).not.toContain("String(error)");
});

function readRepoFile(path: string): string {
  return readFileSync(path, "utf8");
}
