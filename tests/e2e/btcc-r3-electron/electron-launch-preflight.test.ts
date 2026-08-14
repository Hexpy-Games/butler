import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PreparedRun } from "./contracts.ts";
import { failureEvidence } from "./evidence.ts";
import { launchProduct } from "./product-launch.ts";

test("actual Electron launch port preflight emits typed conflict evidence", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "butler-launch-port-"));
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test port.");
    const freePort = await allocateFreePort();
    const binary = join(
      root,
      "packages/butler-app/client/electron/node_modules/.bin/electron",
    );
    const ui = join(root, "packages/butler-app/client/ui/dist/index.html");
    mkdirSync(dirname(binary), { recursive: true });
    mkdirSync(dirname(ui), { recursive: true });
    writeFileSync(binary, "", "utf8");
    writeFileSync(ui, "", "utf8");
    const run = {
      agentOwnership: "electron",
      bundledAgentResourceDir: join(root, "resource"),
      repoRoot: root,
      serverPort: address.port,
      debugPort: freePort,
    } as PreparedRun;
    let failure: unknown;
    try {
      await launchProduct(run, "http://127.0.0.1:1/responses");
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      failure: {
        stage: "electron_launch_preflight",
        cause: "port_conflict",
        owner: "electron_harness",
        exitCode: null,
        signal: null,
        portRole: "app_server",
      },
    });
    const evidence = failureEvidence({
      error: failure,
      observations: [],
      options: {},
      providerRequests: [],
      run,
    });
    expect(evidence.failure).toEqual({
      stage: "electron_launch_preflight",
      cause: "port_conflict",
      owner: "electron_harness",
      exitCode: null,
      signal: null,
      portRole: "app_server",
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

test("actual Electron launch distinguishes an occupied debug port", async () => {
  if (process.platform === "win32") return;
  const root = mkdtempSync(join(tmpdir(), "butler-debug-port-"));
  const debugServer = createServer();
  await new Promise<void>((resolve, reject) => {
    debugServer.once("error", reject);
    debugServer.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = debugServer.address();
    if (!address || typeof address === "string") throw new Error("Missing test port.");
    const binary = join(
      root,
      "packages/butler-app/client/electron/node_modules/.bin/electron",
    );
    const ui = join(root, "packages/butler-app/client/ui/dist/index.html");
    mkdirSync(dirname(binary), { recursive: true });
    mkdirSync(dirname(ui), { recursive: true });
    writeFileSync(binary, "", "utf8");
    writeFileSync(ui, "", "utf8");
    const run = {
      agentOwnership: "electron",
      bundledAgentResourceDir: join(root, "resource"),
      repoRoot: root,
      serverPort: await allocateFreePort(),
      debugPort: address.port,
    } as PreparedRun;
    let failure: unknown;
    try {
      await launchProduct(run, "http://127.0.0.1:1/responses");
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      failure: {
        stage: "electron_launch_preflight",
        cause: "port_conflict",
        owner: "electron_harness",
        exitCode: null,
        signal: null,
        portRole: "electron_debug",
      },
    });
  } finally {
    await new Promise<void>((resolve) => debugServer.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

async function allocateFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing free port.");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
