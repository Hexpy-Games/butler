import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const smokeScript = readFileSync(
  "tests/smoke/app-first-run-setup-smoke.ts",
  "utf8",
);

test("first-run smoke only cleans up test-owned app-server listeners", () => {
  expect(smokeScript).toContain("assertPortAvailable(serverPort)");
  expect(smokeScript).toContain("ownedListenerPids = new Set(listenerPids(serverPort))");
  expect(smokeScript).toContain("cleanupOwnedPort(appServerPort, ownedListenerPids)");
  expect(smokeScript).toContain("listenerPids(port).filter((pid) => ownedPids.has(pid))");
  expect(smokeScript).not.toContain("function cleanupPort");
});

test("first-run smoke launches isolated Electron first-run environment", () => {
  expect(smokeScript).toContain("--user-data-dir=${electronProfileDir}");
  expect(smokeScript).toContain("BUTLER_DATA: dataDir");
  expect(smokeScript).toContain("delete env.BUTLER_APP_SERVER_URL");
  expect(smokeScript).toContain("delete env.BUTLER_APP_UI_URL");
});
