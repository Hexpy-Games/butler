import { expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import {
  evaluateRendererReadiness,
  requireRendererReadiness,
  RendererReadyError,
} from "./renderer-readiness.ts";
import { failureEvidence } from "./evidence.ts";
import { connectElectronPage } from "./cdp-page.ts";

test("renderer readiness distinguishes ready, waiting, and timeout", () => {
  expect(evaluateRendererReadiness({
    ready: true,
    timedOut: false,
    exitCode: null,
    signal: null,
  })).toEqual({ state: "ready" });
  expect(evaluateRendererReadiness({
    ready: false,
    timedOut: false,
    exitCode: null,
    signal: null,
  })).toEqual({ state: "waiting" });
  expect(evaluateRendererReadiness({
    ready: false,
    timedOut: true,
    exitCode: null,
    signal: null,
  })).toEqual({
    state: "failed",
    failure: {
      stage: "renderer_ready",
      cause: "renderer_ready_timeout",
      owner: "electron_harness",
      exitCode: null,
      signal: null,
    },
  });
});

test("connectElectronPage reaches ready through a bounded localhost CDP target", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(request, bunServer) {
      const url = new URL(request.url);
      if (url.pathname === "/cdp") {
        return bunServer.upgrade(request)
          ? undefined
          : new Response("upgrade failed", { status: 400 });
      }
      return Response.json([{
        type: "page",
        url: "http://127.0.0.1/renderer",
        webSocketDebuggerUrl: `ws://127.0.0.1:${bunServer.port}/cdp`,
      }]);
    },
    websocket: {
      message(socket, message) {
        const command = JSON.parse(String(message)) as { id: number };
        socket.send(JSON.stringify({ id: command.id, result: {} }));
      },
    },
  });
  try {
    const port = server.port;
    if (port === undefined) throw new Error("CDP fixture did not bind a port.");
    const child = { exitCode: null, signalCode: null } as ChildProcess;
    const connected = await connectElectronPage(port, child);
    expect(connected.page).toBeDefined();
    connected.client.close();
  } finally {
    server.stop(true);
  }
});

test("connectElectronPage reports an actual early clean exit without polling", async () => {
  const child = { exitCode: 0, signalCode: null } as ChildProcess;
  let failure: unknown;
  try {
    await connectElectronPage(1, child);
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    failure: {
      stage: "renderer_ready",
      cause: "electron_exited",
      owner: "electron_process",
      exitCode: 0,
      signal: null,
    },
  });
});

test("renderer readiness retains clean, nonzero, and signal exit evidence", () => {
  for (const expected of [
    { exitCode: 0, signal: null },
    { exitCode: 7, signal: null },
    { exitCode: null, signal: "SIGTERM" as const },
  ]) {
    const decision = evaluateRendererReadiness({
      ready: false,
      timedOut: false,
      ...expected,
    });
    expect(decision).toEqual({
      state: "failed",
      failure: {
        stage: "renderer_ready",
        cause: "electron_exited",
        owner: "electron_process",
        ...expected,
      },
    });
    expect(() => requireRendererReadiness(decision)).toThrow(RendererReadyError);
  }
});

test("renderer readiness failure is retained in privacy-safe harness evidence", () => {
  const decision = evaluateRendererReadiness({
    ready: false,
    timedOut: false,
    exitCode: 0,
    signal: null,
  });
  let error: unknown;
  try {
    requireRendererReadiness(decision);
  } catch (caught) {
    error = caught;
  }
  const evidence = failureEvidence({
    error,
    observations: [],
    options: {},
    providerRequests: [],
    run: {
      agentOwnership: "electron",
      dataRoot: "/isolated/data",
      debugPort: 41001,
      electronProfile: "/isolated/profile",
      evidencePath: "/isolated/evidence.json",
      runId: "renderer-ready-test",
      runRoot: "/isolated",
      serverPort: 41002,
      workspaceRoot: "/isolated/workspace",
    } as Parameters<typeof failureEvidence>[0]["run"],
  });
  expect(evidence.failure).toEqual({
    stage: "renderer_ready",
    cause: "electron_exited",
    owner: "electron_process",
    exitCode: 0,
    signal: null,
  });
  expect(evidence.providerRequests).toEqual([]);
  expect(JSON.stringify(evidence)).not.toContain("prompt");
});

test("typed failure evidence drops undeclared fields", () => {
  const error = Object.assign(new Error("failed"), {
    failure: {
      stage: "renderer_ready",
      cause: "electron_exited",
      owner: "electron_process",
      exitCode: 1,
      signal: null,
      privatePath: "/private/source",
      rawPayload: "secret",
    },
  });
  const evidence = failureEvidence({
    error,
    observations: [],
    options: {},
    providerRequests: [],
    run: {
      agentOwnership: "electron",
      dataRoot: "/isolated/data",
      debugPort: 41001,
      electronProfile: "/isolated/profile",
      evidencePath: "/isolated/evidence.json",
      runId: "allowlist-test",
      runRoot: "/isolated",
      serverPort: 41002,
      workspaceRoot: "/isolated/workspace",
    } as Parameters<typeof failureEvidence>[0]["run"],
  });
  expect(evidence.failure).toEqual({
    stage: "renderer_ready",
    cause: "electron_exited",
    owner: "electron_process",
    exitCode: 1,
    signal: null,
  });
  expect(JSON.stringify(evidence.failure)).not.toContain("private");
  expect(JSON.stringify(evidence.failure)).not.toContain("secret");
});
