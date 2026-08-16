import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PreparedRun } from "./contracts.ts";
import { productAgentOwnership } from "./isolation-config.ts";
import {
  foregroundReadinessPath,
  waitForNativeExecutorReadiness,
} from "./native-executor.ts";
import { productLaunchEnvironment } from "./product-launch.ts";

function preparedRun(
  root: string,
  ownership: PreparedRun["agentOwnership"],
): PreparedRun {
  return {
    accessMode: "full_access",
    agentOwnership: ownership,
    bundledAgentResourceDir: ownership === "electron"
      ? join(root, "bundled-agent")
      : null,
    dataRoot: join(root, "data"),
    debugPort: 21001,
    electronProfile: join(root, "electron-profile"),
    evidencePath: join(root, "evidence.json"),
    interruptedExecutorReplacementUsed: false,
    model: "openai/test-model",
    projectDisplayName: null,
    projectId: null,
    projectWorkspaceRoot: join(root, "project-workspaces"),
    reasoningEffort: "low",
    repoRoot: root,
    runId: "ownership-test",
    runRoot: root,
    serverPort: 21002,
    sessionId: "chat-ownership-test",
    sessionKind: "chat",
    sessionTitle: "Ownership test",
    sourceData: join(root, "source-data"),
    workspaceRoot: join(root, "workspace"),
  };
}

test("R3 guided runtime selects Electron-owned Agent while R2 remains harness-owned", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-product-ownership-"));
  try {
    expect(productAgentOwnership(root)).toBe("harness");
    const guidedTurnState = join(
      root,
      "packages",
      "butler-agent",
      "src",
      "agent",
      "adapters",
      "btcc",
      "sqlite",
      "guided-turn-state.ts",
    );
    mkdirSync(dirname(guidedTurnState), { recursive: true });
    writeFileSync(guidedTurnState, "export {};\n", "utf8");
    expect(productAgentOwnership(root)).toBe("electron");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Electron-owned launch receives the prepared Agent resource and R2 removes stale injection", () => {
  const root = "/tmp/butler-product-launch-env";
  const inherited = {
    BUTLER_APP_BUNDLED_AGENT_DIR: "/stale/resource",
    PATH: "/usr/bin:/bin",
  };
  const electronRun = preparedRun(root, "electron");
  expect(
    productLaunchEnvironment(electronRun, "http://127.0.0.1:19001", inherited),
  ).toMatchObject({
    BUTLER_APP_BUNDLED_AGENT_DIR: electronRun.bundledAgentResourceDir,
    BUTLER_APP_ALLOW_PRECONFIRMED_E2E_QUIT: "1",
  });
  expect(
    productLaunchEnvironment(
      preparedRun(root, "harness"),
      "http://127.0.0.1:19001",
      {
        ...inherited,
        BUTLER_APP_ALLOW_PRECONFIRMED_E2E_QUIT: "1",
      },
    ).BUTLER_APP_ALLOW_PRECONFIRMED_E2E_QUIT,
  ).toBeUndefined();
  expect(
    productLaunchEnvironment(
      preparedRun(root, "harness"),
      "http://127.0.0.1:19001",
      inherited,
    ).BUTLER_APP_BUNDLED_AGENT_DIR,
  ).toBeUndefined();
});

test("Electron-owned launch observes the actual product executor readiness record", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-product-readiness-"));
  try {
    const run = preparedRun(root, "electron");
    const readiness = foregroundReadinessPath(run);
    mkdirSync(dirname(readiness), { recursive: true });
    const notBeforeMs = Date.now();
    writeFileSync(readiness, `${JSON.stringify({
      schema: "butler.app-foreground-executor-readiness.v1",
      pid: process.pid,
      readyAt: new Date(notBeforeMs).toISOString(),
      rawTextIncluded: false,
    })}\n`, "utf8");
    expect(await waitForNativeExecutorReadiness(run, {
      expectedPid: process.pid,
      notBeforeMs,
      timeoutMs: 1_000,
    })).toBe(process.pid);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
