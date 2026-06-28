import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createAppServer } from "../../packages/butler-agent/src/gateways/app/server.ts";
import { runNativeButlerMain } from "../../packages/butler-agent/src/interfaces/gateway/native-butler-bootstrap.ts";
import { buildNewChatBriefing } from "../../packages/butler-agent/src/gateways/app/new-chat-briefing.ts";
import { AppGatewayBridge } from "../support/app-gateway-bridge.ts";
import {
  appRuntimePolicy,
  createProjectFolderSelectionToken,
} from "../../packages/butler-agent/src/gateways/app/store.ts";
import { compactionPath } from "../../packages/butler-agent/src/agent/context/compaction.ts";
import { appendRuntimeTurnContextMetric } from "../../packages/butler-agent/src/operations/metrics/context-monitor.ts";
import { SessionBindingStore } from "../../packages/butler-agent/src/test-support/harness/session-store.ts";
import {
  appendTranscriptEvent,
  createTranscriptEvent,
  readTranscript,
} from "../../packages/butler-agent/src/test-support/harness/transcripts.ts";
import { PlannedTaskStore } from "../../packages/butler-agent/src/agent/work/planned-task.ts";
import { buildTaskOriginContext } from "../../packages/butler-agent/src/agent/work/task-origin.ts";
import { TaskStore } from "../../packages/butler-agent/src/agent/work/task-store.ts";
import { TodoListStore } from "../../packages/butler-agent/src/agent/work/todo-list.ts";
import { WorkOrchestrationStore } from "../../packages/butler-agent/src/agent/work/work-orchestration.ts";
import { WorkStreamStore } from "../../packages/butler-agent/src/agent/work/work-stream.ts";
import { ModelProviderRequestError } from "../../packages/butler-agent/src/integrations/providers/provider-errors.ts";
import { deliveredWithLimitationsState } from "../../packages/butler-agent/src/agent/turn/runtime-delivery-state.ts";
import {
  discoverLocalModels,
  upsertLocalModelConfig,
} from "../../packages/butler-agent/src/integrations/providers/local-models.ts";
import { appendPromptCacheMetric } from "../../packages/butler-agent/src/integrations/providers/prompt-cache-metrics.ts";
import {
  TURN_ACKNOWLEDGED_EVENT_KIND,
  createTurnAcknowledgedPayload,
} from "../../packages/butler-agent/src/agent/events/turn-state-contract.ts";
import type { ButlerServiceClient } from "../../packages/butler-agent/src/gateways/core/client.ts";
import type {
  AgentRuntimeAdapter,
  ArtifactRef,
  ModelProviderAdapter,
  RuntimeSessionHandle,
  RuntimeSessionInit,
  RuntimeTurnInput,
} from "../../packages/butler-agent/src/test-support/harness/contracts.ts";

let tempDir = "";
let originalFetch: typeof fetch;
let originalButlerData: string | undefined;
let originalButlerHome: string | undefined;
let originalOpenAiApiKey: string | undefined;
let originalButlerUpdateManifest: string | undefined;
const packageVersion = JSON.parse(
  readFileSync(join(process.cwd(), "package.json"), "utf8"),
).version as string;

function currentAppUpdatePlatformForTest(): string {
  const os = process.platform === "darwin" ? "darwin" : process.platform;
  const arch = process.arch === "x64" ? "x64" : process.arch;
  return `${os}-${arch}`;
}

function writeAppUpdateManifest(path: string, version: string): void {
  writeFileSync(path, JSON.stringify({
    schema: "butler.update-manifest.v1",
    product: "butler-app",
    app_version: version,
    bundled_agent_version: version,
    artifacts: [{
      component: "app",
      app_version: version,
      version,
      channel: "stable",
      platform: currentAppUpdatePlatformForTest(),
      artifact_url: null,
      sha256: null,
      signature: null,
      bundled_components: ["app"],
      product: "butler-app",
      gateway_profile: "electron",
      bundled_agent_version: version,
      protocol_compatibility: {
        protocol: "butler.app.v1",
        minimumAppProtocol: "butler.app.v1",
        maximumAppProtocol: "butler.app.v1",
      },
      integrity: {
        digestAlgorithm: "sha256",
        digest: null,
        signature: null,
      },
      update_policy: "app-user-action",
      restart_policy: "restart-app",
      updater_owner: "butler-app",
      payload_format: "platform-app-package",
      staging_policy: "platform-updater-cache",
      activation_policy: "platform-app-update-then-versioned-app-runtime",
      rollback_policy: "preserve-previous-app-managed-runtime",
    }],
  }), "utf8");
}

function writeServiceUpdateManifest(path: string, version: string): void {
  writeFileSync(path, JSON.stringify({
    schema: "butler.update-manifest.v1",
    product: "butler-agent",
    app_version: version,
    bundled_agent_version: version,
    artifacts: [{
      component: "service",
      app_version: version,
      version,
      channel: "stable",
      platform: "all",
      artifact_url: null,
      sha256: null,
      signature: null,
      bundled_components: ["service"],
      product: "butler-agent",
      gateway_profile: "agent-standalone",
      bundled_agent_version: version,
      protocol_compatibility: {
        protocol: "butler.agent.v1",
        minimumAgentProtocol: "butler.agent.v1",
        maximumAgentProtocol: "butler.agent.v1",
      },
      integrity: {
        digestAlgorithm: "sha256",
        digest: null,
        signature: null,
      },
      update_policy: "explicit",
      restart_policy: "restart-service",
      updater_owner: "butler-agent",
      payload_format: "agent-archive",
      staging_policy: "butler-data-updates",
      activation_policy: "versioned-standalone-runtime",
      rollback_policy: "preserve-previous-standalone-runtime",
    }],
  }), "utf8");
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "butler-app-server-"));
  originalFetch = globalThis.fetch;
  originalButlerData = process.env.BUTLER_DATA;
  originalButlerHome = process.env.BUTLER_HOME;
  originalOpenAiApiKey = process.env.OPENAI_API_KEY;
  originalButlerUpdateManifest = process.env.BUTLER_UPDATE_MANIFEST;
  process.env.BUTLER_DATA = tempDir;
  process.env.BUTLER_HOME = process.cwd();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalButlerData === undefined) delete process.env.BUTLER_DATA;
  else process.env.BUTLER_DATA = originalButlerData;
  if (originalButlerHome === undefined) delete process.env.BUTLER_HOME;
  else process.env.BUTLER_HOME = originalButlerHome;
  if (originalOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAiApiKey;
  if (originalButlerUpdateManifest === undefined)
    delete process.env.BUTLER_UPDATE_MANIFEST;
  else process.env.BUTLER_UPDATE_MANIFEST = originalButlerUpdateManifest;
  rmSync(tempDir, { recursive: true, force: true });
});

test("app server exposes health and onboarding chat seed", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
  });
  try {
    const health = await getJson(`${server.url}health`);
    expect(health.protocol_version).toBe("butler.app.v1");
    expect(health.data.ok).toBe(true);

    const chats = await getJson(`${server.url}chats`);
    expect(chats.data).toContainEqual(
      expect.objectContaining({ id: "general", title: "Onboarding" }),
    );
    expect(chats.data.map((chat: { id: string }) => chat.id)).not.toContain(
      "project-butler",
    );
  } finally {
    server.stop();
  }
});

test("app server enforces App local auth for API routes without blocking static UI", async () => {
  const uiRoot = join(tempDir, "ui");
  mkdirSync(uiRoot, { recursive: true });
  writeFileSync(join(uiRoot, "index.html"), "<!doctype html><div>Butler</div>");
  const server = createAppServer({
    dbPath: join(tempDir, "auth-app.sqlite"),
    port: 0,
    uiRoot,
    localAuth: {
      required: true,
      token: "local-auth-token",
    },
  });
  try {
    const unauthenticatedHealth = await fetch(`${server.url}health`);
    expect(unauthenticatedHealth.status).toBe(401);
    const unauthenticatedBody = await unauthenticatedHealth.json();
    expect(unauthenticatedBody.error).toMatchObject({
      code: "local_auth_required",
      message: "Butler App local auth is required.",
    });
    expect(JSON.stringify(unauthenticatedBody)).not.toContain("local-auth-token");

    const wrongToken = await fetch(`${server.url}settings`, {
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(wrongToken.status).toBe(401);

    const health = await fetch(`${server.url}health`, {
      headers: { authorization: "Bearer local-auth-token" },
    });
    expect(health.status).toBe(200);
    expect((await health.json()).data.ok).toBe(true);

    const settings = await fetch(`${server.url}settings`, {
      headers: { authorization: "Bearer local-auth-token" },
    });
    expect(settings.status).toBe(200);
    expect((await settings.json()).data.gateway_profile).toBe("electron");

    const staticUi = await fetch(server.url);
    expect(staticUi.status).toBe(200);
    expect(await staticUi.text()).toContain("Butler");
  } finally {
    server.stop();
  }
});

test("app gateway CLI keeps serving after startup health", async () => {
  const port = await findAvailablePort();
  const dbPath = join(tempDir, "cli-app.sqlite");
  const proc = spawn(process.execPath, [
    join(process.cwd(), "bin", "butler.js"),
    "gateway",
    "app",
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BUTLER_DATA: tempDir,
      BUTLER_HOME: process.cwd(),
      BUTLER_BUN: process.execPath,
      BUTLER_APP_SERVER_PORT: String(port),
      BUTLER_APP_SERVER_URL: `http://127.0.0.1:${port}`,
      BUTLER_APP_SERVER_DB: dbPath,
      BUTLER_APP_SERVER_BRIDGE: "off",
      BUTLER_APP_GATEWAY_PID_FILE: "off",
      BUTLER_APP_BUNDLED_SUPERVISOR: "1",
    },
    stdio: "ignore",
  });

  try {
    await waitForHttpOk(`http://127.0.0.1:${port}/health`);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    if (proc.exitCode !== null) {
      throw new Error("Gateway CLI exited after startup.");
    }
    const health = await getJson(`http://127.0.0.1:${port}/health`);
    expect(health.data.ok).toBe(true);
    expect(existsSync(join(tempDir, "state", "gateways", "app.pid"))).toBe(
      false,
    );
  } finally {
    await terminateChild(proc);
  }
});

test("app gateway CLI enforces App local auth from supervisor auth file", async () => {
  const port = await findAvailablePort();
  const dbPath = join(tempDir, "cli-auth-app.sqlite");
  const authPath = join(tempDir, "app", "runtime", "auth", "local-agent-auth.json");
  mkdirSync(join(tempDir, "app", "runtime", "auth"), { recursive: true });
  writeFileSync(
    authPath,
    `${JSON.stringify({
      schema: "butler.app-local-agent-auth.v1",
      token: "cli-local-auth-token",
      raw_text_included: false,
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const proc = spawn(process.execPath, [
    join(process.cwd(), "bin", "butler.js"),
    "gateway",
    "app",
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BUTLER_DATA: tempDir,
      BUTLER_HOME: process.cwd(),
      BUTLER_BUN: process.execPath,
      BUTLER_APP_SERVER_PORT: String(port),
      BUTLER_APP_SERVER_URL: `http://127.0.0.1:${port}`,
      BUTLER_APP_SERVER_DB: dbPath,
      BUTLER_APP_SERVER_BRIDGE: "off",
      BUTLER_APP_GATEWAY_PID_FILE: "off",
      BUTLER_APP_BUNDLED_SUPERVISOR: "1",
      BUTLER_APP_LOCAL_AUTH_REQUIRED: "1",
      BUTLER_APP_LOCAL_AUTH_FILE: authPath,
    },
    stdio: "ignore",
  });

  try {
    await waitForHttpStatus(`http://127.0.0.1:${port}/health`, 401);
    const unauthenticated = await fetch(`http://127.0.0.1:${port}/health`);
    expect(unauthenticated.status).toBe(401);
    expect(JSON.stringify(await unauthenticated.json())).not.toContain(
      "cli-local-auth-token",
    );

    const authenticated = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { authorization: "Bearer cli-local-auth-token" },
    });
    expect(authenticated.status).toBe(200);
    expect((await authenticated.json()).data.ok).toBe(true);
  } finally {
    await terminateChild(proc);
  }
});

test("app server serves packaged web client dist from Butler home", async () => {
  const butlerHome = mkdtempSync(join(tmpdir(), "butler-packaged-ui-"));
  const packagedDist = join(
    butlerHome,
    "packages",
    "butler-agent",
    "resources",
    "app-client",
    "dist",
  );
  mkdirSync(packagedDist, { recursive: true });
  writeFileSync(
    join(packagedDist, "index.html"),
    "<!doctype html><html><head><title>Butler</title></head><body>packaged</body></html>",
  );
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    butlerHome,
    port: 0,
    automationSchedulerIntervalMs: false,
  });
  try {
    const response = await fetch(server.url);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("<title>Butler</title>");
    expect(html).toContain("packaged");
  } finally {
    server.stop();
    rmSync(butlerHome, { recursive: true, force: true });
  }
});

test("app server exposes app info metadata", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    butlerHome: process.cwd(),
    port: 0,
  });
  try {
    const info = await getJson(`${server.url}app-info`);
    expect(info.data).toMatchObject({
      name: "Butler",
      version: packageVersion,
      repository_url: "https://github.com/Hexpy-Games/butler",
      protocol_version: "butler.app.v1",
      developer_mode_available: false,
      developer_mode_enabled: false,
    });
  } finally {
    server.stop();
  }
});

test("fresh app settings honor an install-selected local model default", async () => {
  const local = upsertLocalModelConfig(
    {
      serverUrl: "http://127.0.0.1:8080",
      platform: "llama_cpp",
      modelId: "gemma-install",
      contextWindowTokens: 32768,
      source: "manual",
    },
    tempDir,
  );
  writeFileSync(
    join(tempDir, "butler.config.json"),
    `${JSON.stringify(
      {
        system: {
          runtime: "codex-api",
          defaultModel: local.model_ref,
          butlerModel: local.model_ref,
        },
        models: {
          local: [local],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    butlerHome: process.cwd(),
    port: 0,
  });
  try {
    const settings = await getJson(`${server.url}settings`);
    expect(settings.data.model).toBe("local/gemma-install");
    expect(settings.data.context_window_tokens).toBe(32768);
    const catalog = await getJson(`${server.url}model-catalog`);
    expect(catalog.data.default_model_ref).toBe("local/gemma-install");
    expect(catalog.data.default_reasoning_effort).toBe("none");
  } finally {
    server.stop();
  }
});

test("app settings enforce and repair the Electron gateway profile", async () => {
  const dbPath = join(tempDir, "gateway-profile.sqlite");
  const server = createAppServer({
    dbPath,
    butlerData: tempDir,
    butlerHome: process.cwd(),
    port: 0,
  });
  try {
    const fresh = await getJson(`${server.url}settings`);
    expect(fresh.data.gateway_profile).toBe("electron");

    const db = new Database(dbPath);
    try {
      db.query(
        `
        INSERT INTO app_settings (key, value_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
          updated_at = excluded.updated_at
      `,
      ).run(
        "settings",
        JSON.stringify({
          ...fresh.data,
          gateway_profile: "terminal",
          bridge_mode: "external",
        }),
        new Date().toISOString(),
      );
    } finally {
      db.close();
    }

    const repaired = await getJson(`${server.url}settings`);
    expect(repaired.data).toMatchObject({
      bridge_mode: "local",
      gateway_profile: "electron",
    });

    const bridgePatch = await fetch(`${server.url}settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bridge_mode: "external" }),
    });
    expect(bridgePatch.status).toBe(400);

    const eventsDb = new Database(dbPath, { readonly: true });
    try {
      const repairEvent = eventsDb
        .query<{ type: string; payload_json: string }, []>(
          `
          SELECT type, payload_json
          FROM events
          WHERE type = 'settings.gateway_profile_repaired'
          ORDER BY id DESC
          LIMIT 1
        `,
        )
        .get();
      expect(repairEvent?.type).toBe("settings.gateway_profile_repaired");
      expect(JSON.parse(repairEvent?.payload_json ?? "{}")).toMatchObject({
        gateway_profile: "electron",
        previous_profile_kind: "string",
        had_previous_profile: true,
        raw_text_included: false,
      });
    } finally {
      eventsDb.close();
    }
  } finally {
    server.stop();
  }
});

test("app server exposes separate update status check and apply endpoints", async () => {
  const updateManifestPath = join(tempDir, "app-update-manifest.json");
  writeAppUpdateManifest(updateManifestPath, packageVersion);
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    butlerHome: process.cwd(),
    appUpdateManifest: updateManifestPath,
    port: 0,
  });
  try {
    const status = await getJson(`${server.url}updates`);
    expect(
      status.data.components.map(
        (item: { component: string }) => item.component,
      ),
    ).toEqual(["app"]);
    expect(
      status.data.components.every(
        (item: { current_version: string }) =>
          item.current_version === packageVersion,
      ),
    ).toBe(true);
    expect(
      status.data.components.find(
        (item: { component: string }) => item.component === "app",
      ),
    ).toMatchObject({
      component: "app",
      product: "butler-app",
      updater_owner: "butler-app",
      bundled_agent_version: packageVersion,
    });
    const agentPointerPath = join(tempDir, "runtime", "agent", "current.json");
    mkdirSync(join(tempDir, "runtime", "agent"), { recursive: true });
    writeFileSync(agentPointerPath, `${JSON.stringify({
      schema: "butler.agent-standalone-runtime-pointer.v1",
      product: "butler-agent",
      profile: "agent-standalone",
      version: "88.0.0",
      runtime_home: join("runtime", "agent", "versions", "88.0.0"),
      raw_text_included: false,
    }, null, 2)}\n`, "utf8");
    const agentPointerBefore = readFileSync(agentPointerPath, "utf8");

    const check = await postJson(`${server.url}updates/check`, {
      component: "app",
    });
    expect(check.data.components).toHaveLength(1);
    expect(check.data.components[0]).toMatchObject({
      component: "app",
      current_version: packageVersion,
      available_version: packageVersion,
      update_available: false,
    });

    const apply = await postJson(`${server.url}updates/apply`, {
      component: "app",
    });
    expect(apply.data).toMatchObject({
      component: "app",
      current_version: packageVersion,
      available_version: packageVersion,
      update_available: false,
      stage_status: "up_to_date",
      stage_path: join("updates", "staged", "app.json"),
    });
    expect(existsSync(join(tempDir, "updates", "staged", "app.json"))).toBe(
      true,
    );
    expect(existsSync(join(tempDir, "updates", "staged", "service.json"))).toBe(
      false,
    );
    expect(readFileSync(agentPointerPath, "utf8")).toBe(agentPointerBefore);
    expect(existsSync(join(tempDir, "runtime", "agent", "versions", packageVersion))).toBe(
      false,
    );
  } finally {
    server.stop();
  }
});

test("packaged app update endpoints use the Electron-provided app version", async () => {
  const runtimeRoot = join(tempDir, "app-runtime");
  mkdirSync(runtimeRoot, { recursive: true });
  writeFileSync(
    join(runtimeRoot, "package.json"),
    `${JSON.stringify({ name: "butler", version: packageVersion }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(join(runtimeRoot, "VERSION"), `${packageVersion}\n`, "utf8");
  const updateManifestPath = join(tempDir, "app-update-manifest.json");
  writeAppUpdateManifest(updateManifestPath, packageVersion);

  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    butlerHome: runtimeRoot,
    appVersion: packageVersion,
    appUpdateManifest: updateManifestPath,
    port: 0,
  });
  try {
    const status = await getJson(`${server.url}updates`);
    expect(status.data.components).toHaveLength(1);
    expect(status.data.components[0]).toMatchObject({
      component: "app",
      current_version: packageVersion,
      available_version: packageVersion,
      update_available: false,
      bundled_agent_version: packageVersion,
      manifest_source: updateManifestPath,
    });

    const check = await postJson(`${server.url}updates/check`, {
      component: "app",
    });
    expect(check.data.components).toHaveLength(1);
    expect(check.data.components[0]).toMatchObject({
      component: "app",
      current_version: packageVersion,
      available_version: packageVersion,
      update_available: false,
      manifest_source: updateManifestPath,
    });

    const apply = await postJson(`${server.url}updates/apply`, {
      component: "app",
      dry_run: true,
    });
    expect(apply.data).toMatchObject({
      component: "app",
      current_version: packageVersion,
      available_version: packageVersion,
      update_available: false,
      stage_status: "dry_run",
      stage_path: join("updates", "staged", "app.json"),
      manifest_source: updateManifestPath,
    });
  } finally {
    server.stop();
  }
});

test("app server migrates message indexes for exact memory queries", () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
  });
  try {
    const indexes = server.store.db
      .query<{ name: string }, []>("PRAGMA index_list(messages)")
      .all()
      .map((row) => row.name);
    expect(indexes).toContain("messages_role_created_idx");
    expect(indexes).toContain("messages_chat_role_created_idx");
    expect(
      server.store.db
        .query(
          `
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'messages_fts'
    `,
        )
        .get(),
    ).toMatchObject({ name: "messages_fts" });
  } finally {
    server.stop();
  }
});

test("app server migrates event indexes for bounded app event scans", () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
  });
  try {
    const indexes = server.store.db
      .query<{ name: string }, []>("PRAGMA index_list(events)")
      .all()
      .map((row) => row.name);
    expect(indexes).toContain("events_type_id_idx");

    const plan = server.store.db
      .query<{ detail: string }, []>(
        `
      EXPLAIN QUERY PLAN
      SELECT id, type, payload_json, created_at
      FROM events
      WHERE type = 'agent.turn_event'
        AND payload_json LIKE '%"turn_id":"turn-plan"%' ESCAPE '\\'
      ORDER BY id DESC
      LIMIT 500
    `,
      )
      .all()
      .map((row) => row.detail)
      .join("\n");
    expect(plan).toContain("USING INDEX events_type_id_idx");
    expect(plan).not.toContain("SCAN events");
  } finally {
    server.stop();
  }
});

test("app server defaults app responder turns to ten minutes", () => {
  const serverSource = readFileSync(
    join(process.cwd(), "packages/butler-agent/src/gateways/app/server.ts"),
    "utf8",
  );
  const cliSource = readFileSync(
    join(process.cwd(), "packages/butler-agent/src/gateways/app/cli.ts"),
    "utf8",
  );

  expect(serverSource).toContain("const DEFAULT_RESPONDER_TIMEOUT_MS = 600_000;");
  expect(cliSource).toContain('BUTLER_APP_SERVER_RESPONDER_TIMEOUT_MS ?? "600000"');
  expect(cliSource).toContain(": 600000");
});

test("app server keeps long responder requests within Bun idle timeout", () => {
  const source = readFileSync(
    join(process.cwd(), "packages/butler-agent/src/gateways/app/server.ts"),
    "utf8",
  );

  expect(source).toContain("MAX_BUN_IDLE_TIMEOUT_SECONDS");
  expect(source).toContain("idleTimeout");
  expect(source).toContain("responderTimeoutMs / 1000");
  expect(source).toContain("Bun rejects idleTimeout values above 255");
});

test("app server live events stream matches replay for turn events", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
  });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const liveResponse = fetch(`${server.url}events/live?cursor=0`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    server.store.appendTurnEvent("general", "turn-live", {
      kind: "assistant.public_note",
      payload: { note: "Working safely" },
    });
    const response = await liveResponse;
    expect(response.ok).toBe(true);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    reader = response.body?.getReader();
    if (!reader) throw new Error("Missing SSE body.");

    const liveEvent = await readSseEvent(
      reader,
      (event) =>
        event.type === "agent.turn_event" &&
        event.payload?.turn_id === "turn-live",
    );
    const livePayload = liveEvent.payload as {
      event?: Record<string, unknown>;
    };
    expect(livePayload.event).toMatchObject({
      sessionId: "general",
      turnId: "turn-live",
      kind: "assistant.public_note",
    });

    const replay = await getJson(`${server.url}events?cursor=0`);
    expect(replay.data.events).toContainEqual(
      expect.objectContaining({
        id: liveEvent.id,
        type: "agent.turn_event",
        payload: expect.objectContaining({
          turn_id: "turn-live",
        }),
      }),
    );
  } finally {
    await reader?.cancel().catch(() => undefined);
    server.stop();
  }
});

test("app server persists and replays deterministic acknowledgement before later turn events", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
  });
  try {
    const acknowledged = server.store.appendTurnEvent("general", "turn-acknowledged", {
      kind: TURN_ACKNOWLEDGED_EVENT_KIND,
      payload: createTurnAcknowledgedPayload({
        safeLabel: "Request received. Preparing the work.",
        transport: "app",
      }),
    });
    const started = server.store.appendTurnEvent("general", "turn-acknowledged", {
      kind: "turn.started",
      payload: { safeLabel: "Started" },
    });

    expect(acknowledged.turnSequence).toBeLessThan(started.turnSequence);
    const replay = await getJson(`${server.url}events?cursor=0`);
    const events = replay.data.events as Array<{
      type: string;
      payload?: {
        turn_id?: string;
        event?: { kind?: string; turnSequence?: number };
        row?: { safe_label?: string; tool_call_id?: string };
      };
    }>;
    const turnEvent = events.find(
      (event) =>
        event.type === "agent.turn_event" &&
        event.payload?.turn_id === "turn-acknowledged" &&
        event.payload.event?.kind === TURN_ACKNOWLEDGED_EVENT_KIND,
    );
    const progressEvent = events.find(
      (event) =>
        event.type === "agent.turn_event.progress" &&
        event.payload?.turn_id === "turn-acknowledged",
    );

    expect(turnEvent?.payload?.event).toMatchObject({
      kind: TURN_ACKNOWLEDGED_EVENT_KIND,
      turnSequence: acknowledged.turnSequence,
    });
    expect(progressEvent?.payload?.row).toMatchObject({
      kind: "turn",
      state: "accepted",
      safe_label: "Request received. Preparing the work.",
    });
    expect(progressEvent?.payload?.row?.tool_call_id).toBeUndefined();
  } finally {
    server.stop();
  }
});

test("app messages emit canonical turn acknowledgement instead of legacy accepted event", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
    responder(input) {
      return { texts: [`reply: ${input.text}`] };
    },
  });
  try {
    const result = await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "ack this turn",
      client_message_id: "client-ack-route",
    });
    const turnId = result.data.turn.id as string;
    const replay = await getJson(`${server.url}events?cursor=0`);
    const turnEvents = replay.data.events
      .filter(
        (event: { type: string; payload?: { turn_id?: string } }) =>
          event.type === "agent.turn_event" &&
          event.payload?.turn_id === turnId,
      )
      .map(
        (event: { payload: { event?: { kind?: string } } }) =>
          event.payload.event?.kind,
      );

    expect(turnEvents).toContain(TURN_ACKNOWLEDGED_EVENT_KIND);
    expect(turnEvents).not.toContain("turn.accepted");
    expect(turnEvents.indexOf(TURN_ACKNOWLEDGED_EVENT_KIND)).toBeLessThan(
      turnEvents.indexOf("turn.started"),
    );
  } finally {
    server.stop();
  }
});

test("internal turn events are not exposed through app event replay", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
  });
  try {
    const internal = server.store.appendTurnEvent("general", "turn-internal", {
      kind: "assistant.public_note",
      visibility: "internal",
      payload: { note: "private internal note" },
    });
    expect(internal.visibility).toBe("internal");

    const replay = await getJson(`${server.url}events?cursor=0`);
    expect(replay.data.events).not.toContainEqual(
      expect.objectContaining({
        type: "agent.turn_event",
        payload: expect.objectContaining({
          turn_id: "turn-internal",
        }),
      }),
    );
    expect(JSON.stringify(replay)).not.toContain("private internal note");
  } finally {
    server.stop();
  }
});

test("event subscribers stay isolated after transient listener failures", () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
  });
  const healthyTypes: string[] = [];
  let throwingCalls = 0;
  const unsubscribeThrowing = server.store.subscribeEvents(() => {
    throwingCalls += 1;
    if (throwingCalls === 1) throw new Error("transient subscriber failure");
  });
  const unsubscribeHealthy = server.store.subscribeEvents((event) => {
    healthyTypes.push(event.type);
  });
  try {
    server.store.appendSafeServerEvent("test.first", { ok: true });
    server.store.appendSafeServerEvent("test.second", { ok: true });

    expect(throwingCalls).toBe(2);
    expect(healthyTypes).toEqual(["test.first", "test.second"]);
  } finally {
    unsubscribeThrowing();
    unsubscribeHealthy();
    server.stop();
  }
});

test("terminal app turns clean up live turn event sequences without resetting replay order", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
    responder(input) {
      input.onTurnEvent?.({
        kind: "assistant.public_note",
        payload: { note: "Working safely" },
      });
      return { texts: [`reply: ${input.text}`] };
    },
  });
  try {
    const result = await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "finish a turn",
    });
    const firstTurnId = result.data.turn.id as string;
    const debugSequences = server.store as unknown as {
      sessionTurnEventSequences: Map<string, number>;
      turnEventSequences: Map<string, number>;
    };
    expect(debugSequences.turnEventSequences.has(firstTurnId)).toBe(false);
    expect(debugSequences.sessionTurnEventSequences.has("general")).toBe(false);

    const replay = await getJson(`${server.url}events?cursor=0`);
    const firstTurnSessionSequences = replay.data.events
      .filter(
        (event: { type: string; payload?: { turn_id?: string } }) =>
          event.type === "agent.turn_event" &&
          event.payload?.turn_id === firstTurnId,
      )
      .map(
        (event: { payload: { event?: { sessionSequence?: number } } }) =>
          event.payload.event?.sessionSequence ?? 0,
      );
    const lastSessionSequence = Math.max(...firstTurnSessionSequences);

    const next = server.store.appendTurnEvent("general", "turn-after-cleanup", {
      kind: "assistant.public_note",
      payload: { note: "Continuing safely" },
    });
    expect(next.sessionSequence).toBe(lastSessionSequence + 1);
    expect(next.turnSequence).toBe(1);
  } finally {
    server.stop();
  }
});

test("navigation starts with no default projects and no workspace paths", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
  });
  try {
    const navigation = await getJson(`${server.url}navigation`);
    expect(
      navigation.data.chats.map((session: { id: string }) => session.id),
    ).toContain("general");
    expect(navigation.data.projects).toEqual([]);
    expect(JSON.stringify(navigation)).not.toContain(process.cwd());
    expect(JSON.stringify(navigation)).not.toContain(tempDir);
    expect(JSON.stringify(navigation)).not.toContain("workspace_path");

    const projects = await getJson(`${server.url}projects`);
    expect(JSON.stringify(projects)).not.toContain("sessions");
    expect(JSON.stringify(projects)).not.toContain(process.cwd());
  } finally {
    server.stop();
  }
});

test("project dashboard reads Project Ledger documents from Butler data home", async () => {
  const butlerData = join(tempDir, ".butler");
  const workspaceRoot = join(tempDir, "project-workspace");

  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData,
    projectWorkspaceRoot: workspaceRoot,
    port: 0,
  });
  try {
    const created = await postJson(`${server.url}projects`, {
      source: "scratch",
      display_name: "Data home project",
    });
    const projectId = created.data.project.id as string;
    const specDir = join(
      butlerData,
      "project-ledger",
      "projects",
      projectId,
      "specs",
    );
    const planDir = join(
      butlerData,
      "project-ledger",
      "projects",
      projectId,
      "plans",
    );
    const workDir = join(
      butlerData,
      "project-ledger",
      "projects",
      projectId,
      "work",
      "dashboard-work",
    );
    const taskDir = join(workDir, "tasks");
    mkdirSync(specDir, { recursive: true });
    mkdirSync(planDir, { recursive: true });
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      join(specDir, "local-spec.md"),
      "# Data home spec\n\nSpec body with [external](https://example.com).",
      "utf8",
    );
    writeFileSync(
      join(planDir, "local-plan.md"),
      "# Data home plan\n\nPlan body.",
      "utf8",
    );
    writeFileSync(
      join(workDir, "work.md"),
      '---\nstatus: "done"\n---\n\n# Data home work\n\nWork body.',
      "utf8",
    );
    writeFileSync(
      join(taskDir, "task.md"),
      '---\nstatus: "done"\n---\n\n# Data home task\n\nTask body.',
      "utf8",
    );

    const dashboard = await getJson(
      `${server.url}projects/${encodeURIComponent(projectId)}/dashboard`,
    );
    expect(dashboard.data.stats.specs).toBe(1);
    expect(dashboard.data.stats.plans).toBe(1);
    expect(
      dashboard.data.documents.map(
        (document: { title: string }) => document.title,
      ),
    ).toContain("Data home spec");
    expect(
      dashboard.data.documents.map(
        (document: { safe_path_label: string }) => document.safe_path_label,
      ),
    ).toContain(`project-ledger/projects/${projectId}/specs/local-spec.md`);
    expect(JSON.stringify(dashboard)).not.toContain(
      `${process.cwd()}/.project-ledger`,
    );
    expect(JSON.stringify(dashboard)).not.toContain("workspace_path");
  } finally {
    server.stop();
  }
});

test("project dashboard resolves Butler data Project Ledger by workspace slug", async () => {
  const butlerData = join(tempDir, ".butler");
  const folderSelectionSecret = "dashboard-data-home-folder-secret";
  const selectedFolder = join(tempDir, "sandy-bot");
  mkdirSync(selectedFolder, { recursive: true });

  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData,
    folderSelectionSecret,
    port: 0,
  });
  try {
    const project = await createExistingFolderProjectForTest(
      server.url,
      selectedFolder,
      folderSelectionSecret,
      "Sandy Bot",
    );
    expect(project.id).not.toBe("sandy-bot");

    const specDir = join(
      butlerData,
      "project-ledger",
      "projects",
      "sandy-bot",
      "specs",
    );
    const planDir = join(
      butlerData,
      "project-ledger",
      "projects",
      "sandy-bot",
      "plans",
    );
    const taskDir = join(
      butlerData,
      "project-ledger",
      "projects",
      "sandy-bot",
      "work",
      "W-SANDY",
      "tasks",
      "T-SANDY-001",
    );
    mkdirSync(specDir, { recursive: true });
    mkdirSync(planDir, { recursive: true });
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      join(specDir, "sandy-spec.md"),
      "# Sandy spec\n\nCanonical data-home spec.",
      "utf8",
    );
    writeFileSync(
      join(planDir, "sandy-plan.md"),
      "# Sandy plan\n\nCanonical data-home plan.",
      "utf8",
    );
    writeFileSync(
      join(taskDir, "task.md"),
      '---\nstatus: "todo"\n---\n\n# Sandy task\n\nNested task body.',
      "utf8",
    );

    const dashboard = await getJson(
      `${server.url}projects/${encodeURIComponent(project.id)}/dashboard`,
    );
    expect(dashboard.data.stats.specs).toBe(1);
    expect(dashboard.data.stats.plans).toBe(1);
    expect(
      dashboard.data.documents.map(
        (document: { safe_path_label: string }) => document.safe_path_label,
      ),
    ).toContain("project-ledger/projects/sandy-bot/specs/sandy-spec.md");
    expect(
      dashboard.data.documents.map(
        (document: { safe_path_label: string }) => document.safe_path_label,
      ),
    ).toContain(
      "project-ledger/projects/sandy-bot/work/W-SANDY/tasks/T-SANDY-001/task.md",
    );
    expect(JSON.stringify(dashboard)).not.toContain(
      `project-ledger/projects/${project.id}/`,
    );
    expect(JSON.stringify(dashboard)).not.toContain("workspace_path");
  } finally {
    server.stop();
  }
});

test("project dashboard falls back to folder Project Ledger documents without leaking paths", async () => {
  const folderSelectionSecret = "dashboard-folder-secret";
  const selectedFolder = join(tempDir, "selected-ledger-project");
  const specDir = join(selectedFolder, ".project-ledger", "specs");
  const planDir = join(selectedFolder, ".project-ledger", "plans");
  mkdirSync(specDir, { recursive: true });
  mkdirSync(planDir, { recursive: true });
  writeFileSync(join(specDir, "folder-spec.md"), "# Folder spec\n\nSpec body.", "utf8");
  writeFileSync(join(planDir, "folder-plan.md"), "# Folder plan\n\nPlan body.", "utf8");
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    folderSelectionSecret,
    port: 0,
  });
  try {
    const project = await createExistingFolderProjectForTest(
      server.url,
      selectedFolder,
      folderSelectionSecret,
      "Butler source",
    );
    const dashboard = await getJson(
      `${server.url}projects/${encodeURIComponent(project.id)}/dashboard`,
    );
    expect(dashboard.data.stats.specs).toBeGreaterThan(0);
    expect(dashboard.data.stats.plans).toBeGreaterThan(0);
    expect(
      dashboard.data.documents.some((document: { safe_path_label: string }) =>
        document.safe_path_label.startsWith("workspace/.project-ledger/specs/"),
      ),
    ).toBe(true);
    expect(
      dashboard.data.documents.some((document: { safe_path_label: string }) =>
        document.safe_path_label.startsWith("workspace/.project-ledger/plans/"),
      ),
    ).toBe(true);
    expect(JSON.stringify(dashboard)).not.toContain(process.cwd());
    expect(JSON.stringify(dashboard)).not.toContain("workspace_path");
  } finally {
    server.stop();
  }
});

test("folder backed projects can contain multiple project sessions", async () => {
  const workspaceRoot = join(tempDir, "project-workspace");
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    projectWorkspaceRoot: workspaceRoot,
    port: 0,
  });
  try {
    const project = await postJson(`${server.url}projects`, {
      source: "scratch",
      display_name: "Session project",
    });
    const projectId = project.data.project.id as string;
    await postJson(`${server.url}sessions`, {
      kind: "project",
      project_id: projectId,
      title: "First project topic",
    });
    const created = await postJson(`${server.url}sessions`, {
      kind: "project",
      project_id: projectId,
      title: "Second project topic",
    });
    expect(created.data.session).toMatchObject({
      kind: "project",
      project_id: projectId,
      title: "Second project topic",
    });

    const sessions = await getJson(
      `${server.url}project-sessions?project_id=${encodeURIComponent(projectId)}`,
    );
    expect(
      sessions.data.sessions.filter(
        (session: { project_id?: string }) => session.project_id === projectId,
      ),
    ).toHaveLength(2);

    const navigation = await getJson(`${server.url}navigation`);
    const sessionProject = navigation.data.projects.find(
      (project: { id: string }) => project.id === projectId,
    );
    expect(sessionProject.active_session_count).toBe(2);
    expect(
      sessionProject.sessions.map((session: { title: string }) => session.title),
    ).toContain("Second project topic");
  } finally {
    server.stop();
  }
});

test("session summaries do not require host git for project workspace metadata", async () => {
  const workspaceRoot = join(tempDir, "project-workspace");
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    projectWorkspaceRoot: workspaceRoot,
    port: 0,
  });
  try {
    const project = await postJson(`${server.url}projects`, {
      source: "scratch",
      display_name: "No Git project",
    });
    const projectId = project.data.project.id as string;
    const session = await postJson(`${server.url}sessions`, {
      kind: "project",
      project_id: projectId,
      title: "Workspace summary",
    });
    const sessionId = session.data.session.id as string;

    const view = await getJson(
      `${server.url}session-view?session_id=${encodeURIComponent(sessionId)}`,
    );
    expect(view.data.branch).toEqual({
      available: false,
      workspace_mode: "folder",
      safe_status: "Project workspace",
    });

    const summary = await getJson(
      `${server.url}session-summary?session_id=${encodeURIComponent(sessionId)}`,
    );
    expect(summary.data.branch_info).toEqual({
      available: false,
      workspace_mode: "folder",
      safe_status: "Project workspace",
    });
  } finally {
    server.stop();
  }
});

test("chat sessions can be renamed and archived through session routes", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
  });
  try {
    const created = await postJson(`${server.url}sessions`, {
      kind: "chat",
      title: "Unsorted research thread",
    });
    const sessionId = created.data.session.id as string;

    const renamed = await patchJson(
      `${server.url}sessions/${encodeURIComponent(sessionId)}`,
      {
        title: "Population report test",
      },
    );
    expect(renamed.data.session).toMatchObject({
      id: sessionId,
      title: "Population report test",
      archived: false,
    });

    let navigation = await getJson(`${server.url}navigation`);
    expect(navigation.data.chats).toContainEqual(
      expect.objectContaining({
        id: sessionId,
        title: "Population report test",
      }),
    );

    const archived = await postJson(
      `${server.url}sessions/${encodeURIComponent(sessionId)}/archive`,
      {},
    );
    expect(archived.data.session).toMatchObject({
      id: sessionId,
      archived: true,
    });

    navigation = await getJson(`${server.url}navigation`);
    expect(
      navigation.data.chats.map((session: { id: string }) => session.id),
    ).not.toContain(sessionId);
  } finally {
    server.stop();
  }
});

test("archived projects and sessions can be listed, restored, and permanently deleted", async () => {
  const workspaceRoot = join(tempDir, "butler-workspace");
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    projectWorkspaceRoot: workspaceRoot,
    port: 0,
  });
  try {
    const chat = await postJson(`${server.url}sessions`, {
      kind: "chat",
      title: "Archived personal chat",
    });
    const chatId = chat.data.session.id as string;
    await postJson(
      `${server.url}sessions/${encodeURIComponent(chatId)}/archive`,
      {},
    );

    const project = await postJson(`${server.url}projects`, {
      source: "scratch",
      display_name: "Archived project",
    });
    const projectId = project.data.project.id as string;
    const projectChat = await postJson(`${server.url}sessions`, {
      kind: "project",
      project_id: projectId,
      title: "Archived project chat",
    });
    const projectChatId = projectChat.data.session.id as string;
    await postJson(
      `${server.url}projects/${encodeURIComponent(projectId)}/archive`,
      {},
    );

    let archives = await getJson(`${server.url}archives`);
    expect(archives.data.pagination).toMatchObject({
      limit: 20,
      offset: 0,
      has_more: false,
    });
    expect(
      archives.data.sessions.map((session: { id: string }) => session.id),
    ).toContain(chatId);
    expect(
      archives.data.sessions.map((session: { id: string }) => session.id),
    ).toContain(projectChatId);
    expect(
      archives.data.sessions.find(
        (session: { id: string }) => session.id === projectChatId,
      ),
    ).toMatchObject({
      project: { id: projectId, display_name: "Archived project" },
    });
    expect(
      archives.data.projects.map((item: { id: string }) => item.id),
    ).toContain(projectId);
    expect(JSON.stringify(archives)).not.toContain(workspaceRoot);
    expect(JSON.stringify(archives)).not.toContain("workspace_path");

    await patchJson(`${server.url}sessions/${encodeURIComponent(chatId)}`, {
      archived: false,
    });
    archives = await getJson(`${server.url}archives`);
    expect(
      archives.data.sessions.map((session: { id: string }) => session.id),
    ).not.toContain(chatId);

    await postJson(
      `${server.url}sessions/${encodeURIComponent(chatId)}/archive`,
      {},
    );
    const deletedChat = await fetch(
      `${server.url}sessions/${encodeURIComponent(chatId)}?permanent=true`,
      { method: "DELETE" },
    );
    expect(deletedChat.status).toBe(200);

    const deletedProject = await fetch(
      `${server.url}projects/${encodeURIComponent(projectId)}?permanent=true`,
      { method: "DELETE" },
    );
    expect(deletedProject.status).toBe(200);

    archives = await getJson(`${server.url}archives`);
    expect(
      archives.data.sessions.map((session: { id: string }) => session.id),
    ).not.toContain(chatId);
    expect(
      archives.data.projects.map((item: { id: string }) => item.id),
    ).not.toContain(projectId);
    expect(
      archives.data.sessions.map((session: { id: string }) => session.id),
    ).not.toContain(projectChatId);
  } finally {
    server.stop();
  }
});

test("scratch project creation makes a collision-free folder backed project without leaking paths", async () => {
  const workspaceRoot = join(tempDir, "butler-workspace");
  mkdirSync(join(workspaceRoot, "New project"), { recursive: true });
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    projectWorkspaceRoot: workspaceRoot,
    port: 0,
  });
  try {
    const created = await postJson(`${server.url}projects`, {
      source: "scratch",
    });
    expect(created.data.project.display_name).toBe("New project 2");
    expect(created.data.project.workspace_label).toBe("New project 2");
    expect(created.data.project.safe_path_label).toBe("New project 2");
    expect(created.data.project.active_session_count).toBe(0);
    expect(statSync(join(workspaceRoot, "New project 2")).isDirectory()).toBe(
      true,
    );
    expect(JSON.stringify(created)).not.toContain(tempDir);
    expect(JSON.stringify(created)).not.toContain("workspace_path");

    const navigation = await getJson(`${server.url}navigation`);
    const project = navigation.data.projects.find(
      (item: { id: string }) => item.id === created.data.project.id,
    );
    expect(project).toMatchObject({
      display_name: "New project 2",
      active_session_count: 0,
    });
    expect(project.sessions).toEqual([]);
  } finally {
    server.stop();
  }
});

test("existing folder project creation requires a signed selection token and reuses active projects", async () => {
  const folderSelectionSecret = "test-folder-selection-secret";
  const selectedFolder = join(tempDir, "selected-project");
  mkdirSync(selectedFolder, { recursive: true });
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    folderSelectionSecret,
    port: 0,
  });
  try {
    const token = createProjectFolderSelectionToken(
      selectedFolder,
      folderSelectionSecret,
    );
    const first = await postJson(`${server.url}projects`, {
      source: "existing_folder",
      display_name: "Selected project",
      folder_selection_token: token,
    });
    const second = await postJson(`${server.url}projects`, {
      source: "existing_folder",
      display_name: "Different name should not duplicate",
      folder_selection_token: token,
    });
    expect(first.data.project).toMatchObject({
      display_name: "Selected project",
      workspace_label: "selected-project",
    });
    expect(second.data.project.id).toBe(first.data.project.id);
    expect(JSON.stringify(first)).not.toContain(tempDir);
    expect(JSON.stringify(second)).not.toContain(tempDir);
  } finally {
    server.stop();
  }
});

test("existing folder project creation rejects unsigned selections without partial project rows", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    folderSelectionSecret: "test-folder-selection-secret",
    port: 0,
  });
  try {
    const response = await fetch(`${server.url}projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "existing_folder",
        folder_selection_token: "v1.invalid.invalid",
      }),
    });
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("folder_selection_invalid");
    expect(JSON.stringify(body)).not.toContain(tempDir);

    const projects = await getJson(`${server.url}projects`);
    expect(
      projects.data.projects.map(
        (project: { display_name: string }) => project.display_name,
      ),
    ).toEqual([]);
  } finally {
    server.stop();
  }
});

test("existing folder project creation rejects sensitive root folders", async () => {
  const folderSelectionSecret = "test-folder-selection-secret";
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    folderSelectionSecret,
    port: 0,
  });
  try {
    const token = createProjectFolderSelectionToken(
      homedir(),
      folderSelectionSecret,
    );
    const response = await fetch(`${server.url}projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "existing_folder",
        folder_selection_token: token,
      }),
    });
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error.code).toBe("project_folder_unsafe");
    expect(JSON.stringify(body)).not.toContain(homedir());
  } finally {
    server.stop();
  }
});

test("project session gateway routing uses the app session hint and project id", async () => {
  const runtime = new ScriptedRuntime("project bridge reply");
  const workspaceRoot = join(tempDir, "routing-workspace");
  const bridge = new AppGatewayBridge({
    butlerHome: tempDir,
    butlerData: tempDir,
    runtime,
    provider: fakeProvider,
    runtimePolicy: {
      requiredNativeTools: ["run_command"],
      required_tools: ["read_tool_output_artifact"],
      requiredNativeToolProfiles: ["workspace"],
    },
  });
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    projectWorkspaceRoot: workspaceRoot,
    port: 0,
    responder: bridge.responder,
  });
  try {
    const project = await postJson(`${server.url}projects`, {
      source: "scratch",
      display_name: "Routing project",
    });
    const projectId = project.data.project.id as string;
    const session = await postJson(`${server.url}sessions`, {
      kind: "project",
      project_id: projectId,
      title: "Project topic routing",
      session_hint: "project-topic-routing",
    });
    await postJson(`${server.url}messages`, {
      chat_id: session.data.session.id,
      text: "route project topic",
    });
    expect(runtime.turns[0]?.input).toMatchObject({
      routingHints: {
        sessionId: "butler/app-project-topic-routing",
        projectId,
      },
      peer: {
        id: "project-topic-routing",
      },
    });
  } finally {
    server.stop();
    bridge.close();
  }
});

test("app gateway bridge preserves runtime limited delivery through app projection", async () => {
  const runtime = new ScriptedRuntime(
    "검증 실패가 남아 있어 완료로 보고하지 않고 복구 가능한 결과로 남겼습니다.",
    undefined,
    undefined,
    deliveredWithLimitationsState({
      limitationCodes: ["validation_failed"],
      limitations: ["Validation suite failed without a later passing receipt: npm test"],
    }),
  );
  const bridge = new AppGatewayBridge({
    butlerHome: tempDir,
    butlerData: tempDir,
    runtime,
    provider: fakeProvider,
    sessionTitleGenerator: false,
  });
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
    responder: bridge.responder,
  });
  try {
    const response = await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "검증 실패가 있으면 완료로 닫지 말고 보고해줘.",
    });
    expect(response.data.turn.state).toBe("thinking");

    const assistant = await waitForAssistantMessageMatching(
      server.url,
      "general",
      (message) => message.status === "delivered",
    );
    expect(assistant).toMatchObject({
      status: "delivered",
      retryable: false,
      delivery_state: "delivered_with_limitations",
      limitation_codes: ["validation_failed"],
      limitations: ["Validation suite failed without a later passing receipt: npm test"],
    });
    expect(assistant.safe_error_code ?? null).toBeNull();

    const deliveredTurn = await waitForLatestTurnMatching(
      server.url,
      "general",
      (turn) => turn.state === "delivered",
    );
    expect(deliveredTurn).toMatchObject({
      state: "delivered",
      safe_status_label: "Delivered with limitations",
      retryable: false,
    });
    expect(deliveredTurn.safe_error_code ?? null).toBeNull();

    const events = await getJson(`${server.url}events?cursor=0`);
    expect(JSON.stringify(events)).not.toContain("turn.failed");
    expect(JSON.stringify(events)).not.toContain("gateway_failed");
  } finally {
    server.stop();
    bridge.close();
  }
});

test("app session access mode supplies structured workspace tool policy", async () => {
  const runtime = new ScriptedRuntime("access mode reply");
  const workspaceRoot = join(tempDir, "access-mode-workspace");
  const bridge = new AppGatewayBridge({
    butlerHome: tempDir,
    butlerData: tempDir,
    runtime,
    provider: fakeProvider,
  });
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    projectWorkspaceRoot: workspaceRoot,
    port: 0,
    responder: bridge.responder,
  });
  try {
    const project = await postJson(`${server.url}projects`, {
      source: "scratch",
      display_name: "Access mode project",
    });
    const projectId = project.data.project.id as string;
    const session = await postJson(`${server.url}sessions`, {
      kind: "project",
      project_id: projectId,
      title: "Access mode routing",
      session_hint: "access-mode-routing",
    });

    await postJson(`${server.url}messages`, {
      chat_id: session.data.session.id,
      text: "코드를 수정하고 검증해줘.",
    });
    const fullAccessPolicy = runtime.turns.at(-1)?.metadata?.runtimePolicy as Record<string, unknown>;
    expect(fullAccessPolicy).toMatchObject({
      accessMode: "full_access",
      requiredNativeToolProfiles: ["workspace"],
    });

    await postJson(`${server.url}messages`, {
      chat_id: session.data.session.id,
      text: "변경은 먼저 물어보고 진행해줘.",
      access_mode: "ask_first",
    });
    const askFirstPolicy = runtime.turns.at(-1)?.metadata?.runtimePolicy as Record<string, unknown>;
    expect(askFirstPolicy).toMatchObject({
      accessMode: "ask_first",
      requiredNativeTools: [],
      required_tools: [],
      requiredNativeToolProfiles: [],
    });

    await postJson(`${server.url}messages`, {
      chat_id: session.data.session.id,
      text: "이번에는 읽기 전용으로 상태만 확인해줘.",
      access_mode: "read_only",
    });
    const readOnlyPolicy = runtime.turns.at(-1)?.metadata?.runtimePolicy as Record<string, unknown>;
    expect(readOnlyPolicy).toMatchObject({
      accessMode: "read_only",
      requiredNativeTools: [],
      required_tools: [],
      requiredNativeToolProfiles: [],
    });
  } finally {
    server.stop();
    bridge.close();
  }
});

test("app runtime policy strips stale workspace required tools outside full access", () => {
  expect(appRuntimePolicy({
    existing: {
      requiredNativeTools: ["run_command", "web_search"],
      required_tools: ["read_tool_output_artifact", "web_read"],
      requiredNativeToolProfiles: ["workspace", "public-web"],
    },
    accessMode: "ask_first",
  })).toMatchObject({
    accessMode: "ask_first",
    requiredNativeTools: ["web_search"],
    required_tools: ["web_read"],
    requiredNativeToolProfiles: ["public-web"],
  });
  expect(appRuntimePolicy({
    existing: {
      requiredNativeTools: ["run_command"],
      required_tools: ["read_tool_output_artifact"],
      requiredNativeToolProfiles: ["workspace"],
    },
    accessMode: "read_only",
  })).toMatchObject({
    accessMode: "read_only",
    requiredNativeTools: [],
    required_tools: [],
    requiredNativeToolProfiles: [],
  });
  expect(appRuntimePolicy({
    existing: {
      requiredNativeTools: ["run_command"],
      required_tools: ["read_tool_output_artifact"],
      requiredNativeToolProfiles: ["workspace"],
    },
    accessMode: "full_access",
  })).toMatchObject({
    accessMode: "full_access",
    requiredNativeTools: ["run_command"],
    required_tools: ["read_tool_output_artifact"],
    requiredNativeToolProfiles: ["workspace"],
  });
});

test("project session hints are normalized before becoming local ids", async () => {
  const workspaceRoot = join(tempDir, "hint-workspace");
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    projectWorkspaceRoot: workspaceRoot,
    port: 0,
  });
  try {
    const project = await postJson(`${server.url}projects`, {
      source: "scratch",
      display_name: "Hint project",
    });
    const projectId = project.data.project.id as string;
    const created = await postJson(`${server.url}sessions`, {
      kind: "project",
      project_id: projectId,
      title: "Unsafe hint shape",
      session_hint: "Project Topic With Spaces",
    });
    expect(created.data.session).toMatchObject({
      id: "project-topic-with-spaces",
      session_hint: "butler/app-project-topic-with-spaces",
    });
  } finally {
    server.stop();
  }
});

test("first responder turn replaces an automatic prompt title with a generated title", async () => {
  const userText =
    "버틀러의 품질을 세부조절할거야.\n응답 길이와 프로젝트 정책도 봐줘.";
  let sawTitleCallback = false;
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
    responder(input) {
      sawTitleCallback = typeof input.onSessionTitle === "function";
      input.onSessionTitle?.("버틀러 품질 조정");
      return { texts: ["done"] };
    },
  });
  try {
    const session = await postJson(`${server.url}sessions`, {
      kind: "chat",
      title: "버틀러의 품질을 세부조절할거야.",
      session_hint: "quality-title",
    });

    await postJson(`${server.url}messages`, {
      chat_id: session.data.session.id,
      text: userText,
    });

    expect(sawTitleCallback).toBe(true);
    expect(server.store.getSession(session.data.session.id).title).toBe(
      "버틀러 품질 조정",
    );
  } finally {
    server.stop();
  }
});

test("generated session titles do not overwrite manual titles", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
    responder(input) {
      input.onSessionTitle?.("자동 제목");
      return { texts: ["done"] };
    },
  });
  try {
    const session = await postJson(`${server.url}sessions`, {
      kind: "chat",
      title: "직접 정한 제목",
      session_hint: "manual-title",
    });

    await postJson(`${server.url}messages`, {
      chat_id: session.data.session.id,
      text: "이 요청은 자동 제목 후보가 아니어야 해.",
    });

    expect(server.store.getSession(session.data.session.id).title).toBe(
      "직접 정한 제목",
    );
  } finally {
    server.stop();
  }
});

test("session creation generates a title from the initial message before returning", async () => {
  process.env.OPENAI_API_KEY = "sk-create-title-test";
  writeFileSync(
    join(tempDir, "butler.config.json"),
    `${JSON.stringify({
      system: {
        runtime: "codex-api",
        defaultModel: "openai/gpt-5.5-codex",
        butlerModel: "openai/gpt-5.5-codex",
      },
    })}\n`,
    "utf8",
  );

  const userText = "오늘을 비가 올것 같아?";
  let sawTitleRequest = false;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = String(input);
    if (!url.includes("api.openai.com/v1/responses")) {
      return await originalFetch(input, init);
    }
    const bodyText = String(init?.body ?? "");
    sawTitleRequest = bodyText.includes("User message") &&
      bodyText.includes(userText);
    return new Response(
      JSON.stringify({
        id: "resp_create_session_title",
        output: [{
          type: "message",
          content: [{ type: "output_text", text: "오늘 날씨" }],
        }],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    butlerHome: process.cwd(),
    port: 0,
  });
  try {
    const session = await postJson(`${server.url}sessions`, {
      kind: "chat",
      title: userText,
      initial_message: userText,
      session_hint: "create-weather-title",
    });

    expect(sawTitleRequest).toBe(true);
    expect(session.data.session.title).toBe("오늘 날씨");
    expect(server.store.getSession(session.data.session.id).title).toBe(
      "오늘 날씨",
    );
  } finally {
    server.stop();
  }
});

test("native butler-main default provider generates app transport session titles", async () => {
  process.env.OPENAI_API_KEY = "sk-title-test";
  writeFileSync(
    join(tempDir, "butler.config.json"),
    `${JSON.stringify({
      system: {
        runtime: "codex-api",
        defaultModel: "openai/gpt-5.5-codex",
        butlerModel: "openai/gpt-5.5-codex",
      },
    })}\n`,
    "utf8",
  );

  const userText = "오늘을 비가 올것 같아?";
  const controller = new AbortController();
  const shutdownWatchdog = setTimeout(() => controller.abort(), 1_000);
  let sawTitleRequest = false;
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    butlerHome: process.cwd(),
    port: 0,
  });

  try {
    const session = await postJson(`${server.url}sessions`, {
      kind: "chat",
      title: userText,
      session_hint: "weather-title",
    });
    const chatId = session.data.session.id;
    await postJson(`${server.url}messages`, {
      chat_id: chatId,
      text: userText,
    });

    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = String(input);
      if (!url.includes("api.openai.com/v1/responses")) {
        return await originalFetch(input, init);
      }
      const bodyText = String(init?.body ?? "");
      sawTitleRequest = bodyText.includes("User message") &&
        bodyText.includes(userText);
      mkdirSync(join(tempDir, "locks"), { recursive: true });
      writeFileSync(join(tempDir, "locks", "butler-shutdown"), "test\n", "utf8");
      return new Response(
        JSON.stringify({
          id: "resp_session_title",
          output: [{
            type: "message",
            content: [{ type: "output_text", text: "오늘 날씨" }],
          }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    await runNativeButlerMain({
      butlerHome: process.cwd(),
      butlerData: tempDir,
      runtime: new ScriptedRuntime("비 예보를 확인해볼게요."),
      shutdownSignal: controller.signal,
      shutdownPollMs: 10,
      workerResultPollMs: 10,
      enableTelegramPolling: false,
    });
    globalThis.fetch = originalFetch;

    await getJson(`${server.url}messages?chat_id=${encodeURIComponent(chatId)}`);
    expect(sawTitleRequest).toBe(true);
    expect(server.store.getSession(chatId).title).toBe("오늘 날씨");
  } finally {
    clearTimeout(shutdownWatchdog);
    globalThis.fetch = originalFetch;
    server.stop();
  }
});

test("system events expose scheduled consolidation and profiling status safely", async () => {
  const schedulerDir = join(tempDir, "state", "scheduler");
  const runsDir = join(tempDir, "cognition", "consolidation", "runs");
  mkdirSync(schedulerDir, { recursive: true });
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(
    join(schedulerDir, "consolidation-cycle.json"),
    JSON.stringify({
      lastRunDate: "2026-05-18",
      lastRunAt: "2026-05-17T19:00:07.938Z",
      status: "ok",
    }),
  );
  writeFileSync(
    join(runsDir, "cr_scheduled_20260517190035.json"),
    JSON.stringify({
      run_id: "cr_scheduled_20260517190035",
      status: "completed",
      started_at: "2026-05-17T19:00:35.141Z",
      completed_at: "2026-05-17T19:04:57.419Z",
      checkpoint_path: "/private/path/must-not-leak.json",
      raw_text_included: false,
      phases: [
        { phase: "preflight", status: "ok", metrics: { ok: true } },
        {
          phase: "profile_consolidation",
          status: "ok",
          metrics: {
            profiling_enabled: true,
            mode: "deep",
            candidate_count: 117,
            promoted_count: 41,
            stable_entry_count: 245,
            transcript_extractor_model: "openai/gpt-5.5",
            transcript_extractor_uses_butler_model: true,
            raw_private_text: "must not leak",
            raw_text_included: false,
          },
        },
      ],
    }),
  );
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
  });
  try {
    const events = await getJson(`${server.url}system-events?limit=1`);
    expect(events.data.raw_text_included).toBe(false);
    expect(events.data.pagination).toMatchObject({
      limit: 1,
      offset: 0,
      has_more: true,
    });
    expect(events.data.pagination.total).toBeGreaterThan(1);
    expect(events.data.events).toHaveLength(1);
    const allEvents = await getJson(`${server.url}system-events?limit=20`);
    expect(allEvents.data.events).toContainEqual(
      expect.objectContaining({
        id: "scheduler:consolidation-cycle",
        kind: "scheduler_job",
        status: "ok",
        occurred_at: "2026-05-17T19:00:07.938Z",
      }),
    );
    expect(allEvents.data.events).toContainEqual(
      expect.objectContaining({
        id: "consolidation:cr_scheduled_20260517190035:profile",
        kind: "profile_consolidation",
        model_ref: "openai/gpt-5.5",
        uses_butler_model: true,
        metrics: expect.arrayContaining([
          { label: "candidate_count", value: 117 },
          { label: "promoted_count", value: 41 },
        ]),
      }),
    );
    const payload = JSON.stringify(allEvents);
    expect(payload).not.toContain("/private/path");
    expect(payload).not.toContain("must not leak");
  } finally {
    server.stop();
  }
});

test("app server exposes safe usage monitor summary", async () => {
  appendPromptCacheMetric({
    ts: Date.now(),
    model: "openai/auto:codex-latest",
    scope: "session-turn",
    promptTokens: 100,
    cachedTokens: 30,
    totalTokens: 145,
  }, { butlerData: tempDir });
  mkdirSync(join(tempDir, "transcripts"), { recursive: true });
  writeFileSync(
    join(tempDir, "transcripts", "butler_main.jsonl"),
    [
      JSON.stringify({
        kind: "tool_call",
        timestamp: new Date().toISOString(),
        payload: {
          name: "get_usage_monitor",
          arguments: { query: "SECRET_USAGE_QUERY" },
        },
      }),
      JSON.stringify({
        kind: "tool_result",
        timestamp: new Date().toISOString(),
        payload: {
          name: "get_usage_monitor",
          ok: true,
          result: { text: "SECRET_USAGE_RESULT" },
        },
      }),
    ].join("\n"),
    "utf8",
  );
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
  });
  try {
    const usage = await getJson(
      `${server.url}usage-monitor?since_hours=24&session_id=butler%2Fmain`,
    );

    expect(usage.data.raw_text_included).toBe(false);
    expect(usage.data.model).toMatchObject({
      requestCount: 1,
      promptTokens: 100,
      cachedTokens: 30,
      uncachedTokens: 70,
      outputTokens: 45,
      totalTokens: 145,
      byScopeUsage: {
        "session-turn": {
          requestCount: 1,
          promptTokens: 100,
          cachedTokens: 30,
          uncachedTokens: 70,
          outputTokens: 45,
          totalTokens: 145,
        },
      },
    });
    expect(usage.data.tools).toMatchObject({
      calls: 1,
      results: 1,
      successes: 1,
      failures: 0,
    });
    expect(usage.data.cost.available).toBe(false);
    expect(JSON.stringify(usage.data)).not.toContain("SECRET_USAGE");
  } finally {
    server.stop();
  }
});

test("new chat briefing reads generated artifacts before neutral fallback copy", async () => {
  writeOnboardingStateForTest(tempDir, "complete");
  const runsDir = join(tempDir, "cognition", "consolidation", "runs");
  const briefingsDir = join(tempDir, "cognition", "consolidation", "briefings", "2026-05-28");
  mkdirSync(runsDir, { recursive: true });
  mkdirSync(briefingsDir, { recursive: true });
  writeFileSync(
    join(runsDir, "cr_scheduled_20260528190045.json"),
    JSON.stringify({
      run_id: "cr_scheduled_20260528190045",
      status: "completed",
      started_at: "2026-05-28T19:00:45.161Z",
      completed_at: "2026-05-28T19:06:50.238Z",
      raw_text_included: false,
      phases: [
        { phase: "preflight", status: "ok", metrics: { ok: true } },
        {
          phase: "profile_consolidation",
          status: "ok",
          metrics: { raw_text_included: false },
        },
      ],
    }),
  );
  writeFileSync(
    join(briefingsDir, "general.json"),
    JSON.stringify({
      schema: "butler.cognition.new-chat-briefing.v1",
      briefing_id: "ncb_test_general",
      scope: "general",
      project_id: null,
      project_name: null,
      locale: "ko",
      moment: "오후 7:06",
      title: "오늘은 어떤 이야기부터 꺼내볼까요?",
      title_variants: {
        morning: "아침엔 어떤 이야기부터 꺼내볼까냐?",
        afternoon: "오후엔 어떤 이야기를 살펴볼까냐?",
        evening: "저녁엔 무엇을 이어볼까냐?",
        night: "오늘 밤엔 무엇을 살펴볼까냐?",
      },
      description: "짧게 열어볼 만한 주제 몇 가지가 있습니다.",
      suggestions: [
        {
          id: "open-source-trends",
          title: "요즘 뜨는 오픈소스",
          description: "최근 주목받는 프로젝트를 살펴보면 새 작업의 힌트를 얻기 쉽습니다.",
          text: "최근 주목받는 오픈소스 프로젝트를 이유와 활용처 중심으로 정리해줘.",
          source_kind: "current_interest",
        },
        {
          id: "reader-mode",
          title: "리더 모드의 본문 선택",
          description: "본문 추출 방식을 보면 웹 읽기 기능의 기준을 잡기 좋습니다.",
          text: "리더 모드 본문 추출 방식을 정리해줘.",
          source_kind: "adjacent_direction",
        },
        {
          id: "search-plan",
          title: "검색을 나누는 법",
          description: "넓은 질문은 갈래를 먼저 나누면 검증이 편해집니다.",
          text: "검색 요청을 빠른 확인과 깊은 검증으로 나눠줘.",
          source_kind: "current_interest",
        },
        {
          id: "daily-briefing",
          title: "오늘 볼 만한 소식",
          description: "날씨와 주요 이슈를 짧게 보면 하루를 놓기 쉽습니다.",
          text: "오늘 볼 만한 소식을 짧게 브리핑해줘.",
          source_kind: "timely_context",
        },
      ],
      source: {
        consolidation_run_id: "cr_scheduled_20260528190045",
        generated_at: "2026-05-28T19:06:50.238Z",
        persona_id: "active",
        persona_applied: true,
        profile_projection_id: "active",
        profile_projection_updated_at: "2026-05-28T19:06:50.238Z",
        project_ledger_snapshot_id: null,
        model_ref: "openai/gpt-5.5",
        reasoning_effort: "medium",
        raw_text_included: false,
      },
      raw_text_included: false,
    }),
    "utf8",
  );

  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
  });
  try {
    await patchJson(`${server.url}settings`, { language: "ko" });
    const result = await getJson(
      `${server.url}new-chat-briefing?date=2026-05-28`,
    );
    expect(result.data.raw_text_included).toBe(false);
    expect(result.data.source).toMatchObject({
      scope: "general",
      content_origin: "generated",
      consolidation_run_id: "cr_scheduled_20260528190045",
      locale: "ko",
      persona_applied: true,
      profile_projection_applied: true,
    });
    const expectedRouteTitle = (() => {
      const hour = new Date().getHours();
      if (hour < 6) return "오늘 밤엔 무엇을 살펴볼까냐?";
      if (hour < 12) return "아침엔 어떤 이야기부터 꺼내볼까냐?";
      if (hour < 18) return "오후엔 어떤 이야기를 살펴볼까냐?";
      if (hour < 22) return "저녁엔 무엇을 이어볼까냐?";
      return "오늘 밤엔 무엇을 살펴볼까냐?";
    })();
    expect(result.data.title).toBe(expectedRouteTitle);
    expect(result.data.suggestions).toContainEqual(
      expect.objectContaining({
        title: "요즘 뜨는 오픈소스",
      }),
    );
    const payload = JSON.stringify(result.data);
    expect(payload).not.toContain("raw profile");
    expect(payload).not.toContain("current_attention");
    const morningView = buildNewChatBriefing({
      butlerData: tempDir,
      preferredLocale: "ko",
      date: "2026-05-28",
      now: new Date(2026, 4, 28, 9, 0),
    });
    const nightView = buildNewChatBriefing({
      butlerData: tempDir,
      preferredLocale: "ko",
      date: "2026-05-28",
      now: new Date(2026, 4, 28, 23, 0),
    });
    expect(morningView.title).toBe("아침엔 어떤 이야기부터 꺼내볼까냐?");
    expect(nightView.title).toBe("오늘 밤엔 무엇을 살펴볼까냐?");
    expect(morningView.moment).toContain("9");
  } finally {
    server.stop();
  }
});

test("new chat briefing fallback stays neutral and placeholder-sized", () => {
  writeOnboardingStateForTest(tempDir, "complete");
  const personasDir = join(tempDir, "personas");
  mkdirSync(personasDir, { recursive: true });
  writeFileSync(
    join(personasDir, "active.md"),
    "# Neko Servant\n\nVoice: concise Korean copy ending naturally with 다냐.",
    "utf8",
  );

  const view = buildNewChatBriefing({
    butlerData: tempDir,
    preferredLocale: "ko",
    date: "2099-01-01",
    now: new Date(2026, 4, 28, 8, 0),
  });

  expect(view.title).toBe("오늘의 일을 같이 펼쳐볼까요");
  expect(view.source).toMatchObject({
    content_origin: "heuristic_fallback",
    persona_applied: false,
    profile_projection_applied: false,
  });
  expect(view.suggestions).toHaveLength(4);
  expect(view.suggestions[0]).toMatchObject({ title: "오늘 볼 만한 소식" });
  expect(JSON.stringify(view)).not.toContain("다냐");
  expect(JSON.stringify(view)).not.toContain("냥");
});

test("new chat briefing returns localized onboarding fallback until onboarding completes", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
  });
  try {
    const initialPersonalization = await getJson(`${server.url}personalization`);
    expect(initialPersonalization.data.response_language).toBe("en");

    const englishBriefing = await getJson(`${server.url}new-chat-briefing`);
    expect(englishBriefing.data).toMatchObject({
      moment: "Onboarding",
      title: "Pleased to meet you. It will be my honor to serve.",
      source: {
        scope: "onboarding",
        content_origin: "heuristic_fallback",
        locale: "en",
      },
    });
    expect(englishBriefing.data.suggestions).toHaveLength(1);
    expect(englishBriefing.data.suggestions[0]).toMatchObject({
      title: "Get acquainted with Butler",
    });

    const localized = await patchJson(`${server.url}personalization`, {
      response_language: "ko",
    });
    expect(localized.data.response_language).toBe("ko");
    const koreanBriefing = await getJson(`${server.url}new-chat-briefing`);
    expect(koreanBriefing.data).toMatchObject({
      moment: "온보딩",
      title: "반갑습니다. 당신을 모시게 되어 기쁩니다.",
      description:
        "AI 에이전트 집사 버틀러를 선택해주셔서 감사합니다. 시작하기에 앞서 간단하게 당신에 대해 알려주세요.",
      source: {
        scope: "onboarding",
        locale: "ko",
      },
    });
    expect(koreanBriefing.data.suggestions).toEqual([
      expect.objectContaining({
        title: "버틀러와 알아가기",
        description: "버틀러를 사용하기에 앞서 기본적인 설정을 진행합니다.",
      }),
    ]);

    writeOnboardingStateForTest(tempDir, "complete");
    const completedBriefing = await getJson(`${server.url}new-chat-briefing`);
    expect(completedBriefing.data.source.scope).toBe("general");
    expect(completedBriefing.data.title).not.toBe(
      "반갑습니다. 당신을 모시게 되어 기쁩니다.",
    );
  } finally {
    server.stop();
  }
});

test("new chat briefing returns project scoped opening cards", async () => {
  writeOnboardingStateForTest(tempDir, "complete");
  const personasDir = join(tempDir, "personas");
  const projectPlansDir = join(
    tempDir,
    "project-ledger",
    "projects",
    "butler",
    "plans",
  );
  mkdirSync(personasDir, { recursive: true });
  mkdirSync(projectPlansDir, { recursive: true });
  writeFileSync(
    join(personasDir, "active.md"),
    "# Neko Servant\n\nVoice: concise Korean copy ending naturally with 다냐.",
    "utf8",
  );
  writeFileSync(
    join(projectPlansDir, "plan-butler-new-chat-opening.md"),
    [
      "# Butler New Chat Opening",
      "",
      "Refine the new chat empty state, briefing cards, and first conversation opening.",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(projectPlansDir, "plan-butler-electron-first-launch-defaults-r7.md"),
    [
      "# Butler Electron First Launch Defaults R7",
      "",
      "Electron first launch window size and default sidebar state.",
    ].join("\n"),
    "utf8",
  );

  const workspaceRoot = join(tempDir, "project-briefing-workspace");
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    projectWorkspaceRoot: workspaceRoot,
    port: 0,
  });
  try {
    await patchJson(`${server.url}settings`, { language: "ko" });
    const project = await postJson(`${server.url}projects`, {
      source: "scratch",
      display_name: "butler",
    });
    const projectId = project.data.project.id as string;
    const result = await getJson(
      `${server.url}new-chat-briefing?project_id=${encodeURIComponent(projectId)}`,
    );
    expect(result.data.raw_text_included).toBe(false);
    expect(result.data.moment).toBe("프로젝트");
    expect(result.data.source).toMatchObject({
      scope: "project",
      content_origin: "heuristic_fallback",
      project_id: projectId,
      project_name: "Butler",
      persona_applied: false,
    });
    expect(result.data.title).toBe("Butler에서 이어갈 일을 살펴볼까요");
    expect(result.data.title).not.toContain("아침");
    expect(result.data.suggestions).toContainEqual(
      expect.objectContaining({
        title: "위험한 부분 먼저 보기",
      }),
    );
    expect(result.data.suggestions).toContainEqual(
      expect.objectContaining({
        title: "오늘의 순서 세우기",
      }),
    );
    const payload = JSON.stringify(result.data);
    expect(payload).not.toContain("project-ledger/projects");
    expect(payload).not.toContain("plan-butler-new-chat-opening");
    expect(payload).not.toContain("다냐");
    expect(payload).not.toContain("냥");
  } finally {
    server.stop();
  }
});

test("settings, command palette, and project actions are route-backed and privacy safe", async () => {
  const workspaceRoot = join(tempDir, "settings-project-workspace");
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    projectWorkspaceRoot: workspaceRoot,
    port: 0,
  });
  try {
    const settings = await getJson(`${server.url}settings`);
    expect(settings.data).toMatchObject({
      bridge_mode: "local",
      model: "openai/gpt-5.5",
      reasoning_effort: "xhigh",
      timezone: expect.any(String),
      consolidation_model: "default",
      consolidation_reasoning_effort: "xhigh",
      effective_consolidation_model: "openai/gpt-5.5",
      consolidation_uses_butler_model: true,
      context_window_tokens: 258_000,
      access_mode: "full_access",
      multiline_send_behavior: "modifier_enter_send_enter_newline",
      main_screen_theme: "bloom",
      main_screen_theme_preset: "monochrome",
      main_screen_theme_custom_colors: [
        "#32424d",
        "#555d7c",
        "#485c70",
        "#6a7d9a",
        "#53708d",
        "#434d70",
      ],
      desktop_notifications: {
        enabled: true,
        assistant_messages: true,
        task_completions: true,
      },
      desktop_tray_enabled: true,
    });
    expect(settings.data.worker_model_rules).toEqual([
      expect.objectContaining({
        id: "deep_work",
        model: "openai/gpt-5.5",
        reasoning_effort: "high",
        enabled: true,
      }),
      expect.objectContaining({
        id: "routine_work",
        model: "openai/gpt-5.4-mini",
        reasoning_effort: "medium",
        enabled: true,
      }),
    ]);
    expect(settings.data.web_search).toMatchObject({
      provider: "duckduckgo-html",
      api_key_configured: false,
      api_key_env_var: null,
      planning_enabled: true,
      planning_default_depth: "balanced",
    });
    expect(settings.data.web_search).not.toHaveProperty("planning_mode");
    expect(settings.data.web_search).not.toHaveProperty(
      "planning_allow_parallel_search",
    );
    expect(settings.data.web_search).not.toHaveProperty(
      "planning_disable_smart_for_weak_model",
    );

    await patchJson(`${server.url}settings`, {
      main_screen_theme_preset: "custom",
      main_screen_theme_custom_colors: settings.data
        .main_screen_theme_custom_colors as string[],
    });
    const promotedTheme = await getJson(`${server.url}settings`);
    expect(promotedTheme.data).toMatchObject({
      main_screen_theme_preset: "monochrome",
      main_screen_theme_custom_colors: settings.data
        .main_screen_theme_custom_colors as string[],
    });

    const catalog = await getJson(`${server.url}model-catalog`);
    expect(catalog.data.default_model_ref).toBe("openai/gpt-5.5");
    expect(catalog.data.default_reasoning_effort).toBe("xhigh");
    const providerIds = catalog.data.providers.map(
      (provider: { provider_id: string }) => provider.provider_id,
    );
    for (const providerId of [
      "openai",
      "anthropic",
      "google",
      "xai",
      "qwen",
      "kimi",
      "zai",
    ]) {
      expect(providerIds).toContain(providerId);
    }
    for (const providerId of [
      "openai",
      "anthropic",
      "google",
      "xai",
      "qwen",
      "kimi",
      "zai",
    ]) {
      const provider = catalog.data.providers.find(
        (item: { provider_id: string }) => item.provider_id === providerId,
      );
      expect(provider?.models?.length ?? 0).toBeGreaterThan(0);
    }
    const modelRefs = catalog.data.models.map(
      (model: { model_ref: string }) => model.model_ref,
    );
    expect(modelRefs).toContain("xai/grok-4.3");
    expect(modelRefs).toContain("qwen/qwen3.7-max");
    expect(modelRefs).toContain("kimi/kimi-k2.6");
    expect(modelRefs).toContain("zai/glm-5.2");
    expect(
      catalog.data.models.find(
        (model: { model_ref: string }) => model.model_ref === "zai/glm-5.2",
      ),
    ).toMatchObject({
      context_window_tokens: 1_000_000,
      max_output_tokens: 128_000,
      runtime_supported: true,
    });
    expect(
      catalog.data.models.some(
        (model: { model_ref: string }) => model.model_ref === "openai/gpt-5.5",
      ),
    ).toBe(true);
    expect(
      catalog.data.models.find(
        (model: { model_ref: string }) => model.model_ref === "openai/gpt-5.5",
      ),
    ).toMatchObject({
      context_window_tokens: 1_050_000,
      runtime_supported: true,
    });
    expect(
      catalog.data.models.find(
        (model: { model_ref: string }) =>
          model.model_ref === "openai/gpt-5.4-mini",
      ),
    ).toMatchObject({
      context_window_tokens: 400_000,
      default_reasoning_effort: "medium",
      runtime_supported: true,
    });
    expect(catalog.data.worker_model_presets).toContainEqual(
      expect.objectContaining({
        provider_id: "openai",
        runtime_supported: true,
        deep_work: expect.objectContaining({
          model: "openai/gpt-5.5",
          reasoning_effort: "high",
        }),
        routine_work: expect.objectContaining({
          model: "openai/gpt-5.4-mini",
          reasoning_effort: "medium",
        }),
      }),
    );
    expect(catalog.data.worker_model_presets).toContainEqual(
      expect.objectContaining({
        provider_id: "anthropic",
        runtime_supported: true,
      }),
    );

    const updated = await patchJson(`${server.url}settings`, {
      model: "openai/gpt-5.4",
      reasoning_effort: "high",
      timezone: "Asia/Seoul",
      context_window_tokens: 150_000,
      plan_mode_default: true,
      diagnostics_enabled: true,
      desktop_notifications: {
        enabled: false,
        assistant_messages: true,
        task_completions: false,
      },
      desktop_tray_enabled: false,
      multiline_send_behavior: "enter_send_shift_enter_newline",
      main_screen_theme: "silk",
      main_screen_theme_preset: "custom",
      main_screen_theme_custom_colors: [
        "#111111",
        "#222222",
        "#333333",
        "#444444",
        "#555555",
        "#666666",
      ],
    });
    expect(updated.data).toMatchObject({
      model: "openai/gpt-5.4",
      reasoning_effort: "high",
      timezone: "Asia/Seoul",
      consolidation_model: "default",
      consolidation_reasoning_effort: "xhigh",
      effective_consolidation_model: "openai/gpt-5.4",
      context_window_tokens: 150_000,
      plan_mode_default: true,
      diagnostics_enabled: true,
      desktop_notifications: {
        enabled: false,
        assistant_messages: true,
        task_completions: false,
      },
      desktop_tray_enabled: false,
      multiline_send_behavior: "enter_send_shift_enter_newline",
      main_screen_theme: "silk",
      main_screen_theme_preset: "custom",
      main_screen_theme_custom_colors: [
        "#111111",
        "#222222",
        "#333333",
        "#444444",
        "#555555",
        "#666666",
      ],
    });
    const legacyThemeUpdate = await patchJson(`${server.url}settings`, {
      main_screen_theme: "curtain",
    });
    expect(legacyThemeUpdate.data.main_screen_theme).toBe("silk");
    const consolidationModelUpdated = await patchJson(`${server.url}settings`, {
      consolidation_model: "openai/gpt-5.4-mini",
      consolidation_reasoning_effort: "medium",
    });
    expect(consolidationModelUpdated.data).toMatchObject({
      consolidation_model: "openai/gpt-5.4-mini",
      consolidation_reasoning_effort: "medium",
      effective_consolidation_model: "openai/gpt-5.4-mini",
      consolidation_uses_butler_model: false,
    });
    const migratedShortcut = await patchJson(`${server.url}settings`, {
      multiline_send_behavior: "enter_newline_shift_enter_send",
    });
    expect(migratedShortcut.data.multiline_send_behavior).toBe(
      "modifier_enter_send_enter_newline",
    );
    const contextDetails = await getJson(
      `${server.url}context-details?session_id=general`,
    );
    expect(contextDetails.data).toMatchObject({
      model_ref: "openai/gpt-5.4",
      budget_tokens: 150_000,
    });
    expect(
      contextDetails.data.categories.every(
        (category: { budget_tokens: number }) =>
          category.budget_tokens === 150_000,
      ),
    ).toBe(true);
    await patchJson(`${server.url}sessions/general/controls`, {
      model: "openai/gpt-5.5",
      reasoning_effort: "medium",
    });
    const sessionOverrideContext = await getJson(
      `${server.url}context-details?session_id=general`,
    );
    expect(sessionOverrideContext.data).toMatchObject({
      model_ref: "openai/gpt-5.5",
      budget_tokens: 258_000,
    });
    expect(
      sessionOverrideContext.data.categories.every(
        (category: { budget_tokens: number }) =>
          category.budget_tokens === 258_000,
      ),
    ).toBe(true);
    const normalized = await patchJson(`${server.url}settings`, {
      model: "openai/gpt-5.4-mini",
      reasoning_effort: "low",
      context_window_tokens: 2_000_000,
    });
    expect(normalized.data).toMatchObject({
      model: "openai/gpt-5.4-mini",
      reasoning_effort: "low",
      context_window_tokens: 400_000,
    });
    const ignoredInvalidModel = await patchJson(`${server.url}settings`, {
      model: "not-a-provider/not-real",
    });
    expect(ignoredInvalidModel.data.model).toBe("openai/gpt-5.4-mini");
    const searchProviderUpdated = await patchJson(`${server.url}settings`, {
      web_search: { provider: "brave" },
    });
    expect(searchProviderUpdated.data.web_search).toMatchObject({
      provider: "brave",
      api_key_configured: false,
      api_key_env_var: "BUTLER_BRAVE_SEARCH_API_KEY",
    });
    const searchApiKeyUpdated = await patchJson(`${server.url}settings`, {
      web_search: { api_key: "brave-secret" },
    });
    expect(searchApiKeyUpdated.data.web_search).toMatchObject({
      provider: "brave",
      api_key_configured: true,
      api_key_env_var: "BUTLER_BRAVE_SEARCH_API_KEY",
    });
    expect(JSON.stringify(searchApiKeyUpdated)).not.toContain("brave-secret");
    expect(readFileSync(join(tempDir, ".env"), "utf8")).toContain(
      'BUTLER_BRAVE_SEARCH_API_KEY="brave-secret"',
    );

    const invalidSettings = await fetch(`${server.url}settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openai/gpt-5.5",
        unexpected_field: "must not pass",
      }),
    });
    const invalidSettingsBody = await invalidSettings.json();
    expect(invalidSettings.status).toBe(400);
    expect(invalidSettingsBody.error.code).toBe("invalid_settings_request");
    expect(JSON.stringify(invalidSettingsBody)).not.toContain(
      "unexpected_field",
    );

    const invalidWorkerRuleSettings = await fetch(`${server.url}settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        worker_model_rules: [
          {
            id: "deep",
            label: "Deep",
            condition: "Deep work",
            model: "openai/gpt-5.5",
            reasoning_effort: "high",
            enabled: true,
            unexpected_nested_field: "must not pass",
          },
        ],
      }),
    });
    const invalidWorkerRuleBody = await invalidWorkerRuleSettings.json();
    expect(invalidWorkerRuleSettings.status).toBe(400);
    expect(invalidWorkerRuleBody.error.code).toBe("invalid_settings_request");
    expect(JSON.stringify(invalidWorkerRuleBody)).not.toContain(
      "unexpected_nested_field",
    );

    const workerRulesUpdated = await patchJson(`${server.url}settings`, {
      worker_model_rules: [
        {
          id: "routine search work",
          label: "Routine search work",
          condition: "Search, inspect, and format",
          model: "openai/gpt-5.4-mini",
          reasoning_effort: "medium",
          enabled: true,
        },
        {
          id: "anthropic-runtime-work",
          label: "Anthropic runtime work",
          condition: "Provider wired through native runtime",
          model: "anthropic/claude-opus-4-7",
          reasoning_effort: "high",
          enabled: true,
        },
      ],
    });
    expect(workerRulesUpdated.data.worker_model_rules).toEqual([
      expect.objectContaining({
        id: "routine-search-work",
        label: "Routine search work",
        model: "openai/gpt-5.4-mini",
        reasoning_effort: "medium",
        enabled: true,
      }),
      expect.objectContaining({
        id: "anthropic-runtime-work",
        label: "Anthropic runtime work",
        model: "anthropic/claude-opus-4-7",
        reasoning_effort: "high",
        enabled: true,
      }),
    ]);

    await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "private transcript search sentinel",
    });
    const palette = await getJson(
      `${server.url}command-palette?query=private%20transcript`,
    );
    expect(palette.data.results).toEqual([]);
    expect(JSON.stringify(palette)).not.toContain(
      "private transcript search sentinel",
    );
    const systemPalette = await getJson(
      `${server.url}command-palette?query=system%20events`,
    );
    expect(systemPalette.data.results).toContainEqual(
      expect.objectContaining({
        kind: "settings",
        route: "settings:System events",
      }),
    );

    const createdProject = await postJson(`${server.url}projects`, {
      source: "scratch",
      display_name: "Butler",
    });
    const projectId = createdProject.data.project.id as string;
    const renamed = await patchJson(`${server.url}projects/${projectId}`, {
      display_name: "Renamed Butler",
      pinned: false,
    });
    expect(renamed.data.project).toMatchObject({
      display_name: "Renamed Butler",
      pinned: false,
    });
    const archived = await postJson(
      `${server.url}projects/${projectId}/archive`,
      {},
    );
    expect(archived.data.project.archived).toBe(true);
  } finally {
    server.stop();
  }
});

test("message responders receive configured worker model rules", async () => {
  const responderInputs: Array<{ workerModelRules?: unknown[] }> = [];
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
    responder(input) {
      responderInputs.push({ workerModelRules: input.workerModelRules });
      return { texts: ["ok"] };
    },
  });
  try {
    await patchJson(`${server.url}settings`, {
      worker_model_rules: [
        {
          id: "deep_work",
          label: "Deep work",
          condition: "Research and analysis",
          model: "openai/gpt-5.5",
          reasoning_effort: "high",
          enabled: true,
        },
      ],
    });

    await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "start worker",
    });

    expect(responderInputs[0]?.workerModelRules).toContainEqual(
      expect.objectContaining({
        id: "deep_work",
        model: "openai/gpt-5.5",
        reasoning_effort: "high",
        enabled: true,
      }),
    );
  } finally {
    server.stop();
  }
});

test("local model discovery registers safe runtime-supported catalog entries", async () => {
  const localServer = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/v1/models") {
        return Response.json({
          data: [
            {
              id: "gemma-4-31B-it-Q4_K_M.gguf",
              object: "model",
              owned_by: "llamacpp",
              meta: {
                n_ctx_train: 262_144,
              },
            },
          ],
        });
      }
      if (url.pathname === "/props") {
        return Response.json({
          default_generation_settings: {
            n_ctx: 16_384,
          },
          model_path:
            "C:\\Users\\yeonw\\dev\\models\\gemma-4-31B-it-Q4_K_M.gguf",
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
  });
  try {
    const discovery = await postJson(
      `${server.url}model-catalog/local/discover`,
      {
        provider_id: "local",
        api_type: "openai_compatible",
        platform: "llama_cpp",
        server_url: localServer.url.toString(),
      },
    );
    expect(discovery.data.models).toContainEqual(
      expect.objectContaining({
        provider_id: "local",
        model_ref: "local/gemma-4-31B-it-Q4_K_M.gguf",
        context_window_tokens: 16_384,
        runtime_supported: true,
        api_type: "openai_compatible",
        platform: "llama_cpp",
      }),
    );
    expect(JSON.stringify(discovery)).not.toContain("C:\\Users");
    expect(JSON.stringify(discovery)).not.toContain("model_path");

    const discoveredModel = discovery.data.models[0];
    const registered = await postJson(
      `${server.url}model-catalog/local-models`,
      {
        provider_id: "local",
        api_type: "openai_compatible",
        platform: "llama_cpp",
        server_url: discovery.data.server_url,
        model_id: discoveredModel.model_id,
        display_name: discoveredModel.display_name,
        context_window_tokens: discoveredModel.context_window_tokens,
        max_output_tokens: discoveredModel.max_output_tokens,
        reasoning_budget_ratio: 0.25,
        source: "discovered",
      },
    );
    expect(registered.data.model).toMatchObject({
      model_ref: "local/gemma-4-31B-it-Q4_K_M.gguf",
      context_window_tokens: 16_384,
      default_reasoning_effort: "high",
      reasoning_efforts: ["none", "high"],
      reasoning_budget_tokens: {
        high: 1024,
      },
      local_reasoning_budget_ratio: 0.25,
      runtime_supported: true,
    });
    expect(
      registered.data.catalog.models.map(
        (model: { model_ref: string }) => model.model_ref,
      ),
    ).toContain("local/gemma-4-31B-it-Q4_K_M.gguf");

    const settings = await patchJson(`${server.url}settings`, {
      model: "local/gemma-4-31B-it-Q4_K_M.gguf",
      context_window_tokens: 999_999,
      reasoning_effort: "high",
    });
    expect(settings.data).toMatchObject({
      model: "local/gemma-4-31B-it-Q4_K_M.gguf",
      context_window_tokens: 16_384,
      reasoning_effort: "high",
    });
  } finally {
    server.stop();
    localServer.stop(true);
  }
});

test("local model discovery reads vLLM max_model_len as context window", async () => {
  const localServer = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/v1/models") {
        return Response.json({
          object: "list",
          data: [{
            id: "gemma-4-31B-it",
            object: "model",
            owned_by: "vllm",
            max_model_len: 128_000,
          }],
        });
      }
      return new Response("not found", { status: 404 });
    },
  });

  try {
    const discovery = await discoverLocalModels({
      serverUrl: localServer.url.toString(),
      platform: "custom",
      apiType: "openai_compatible",
    });

    expect(discovery.models[0]).toMatchObject({
      model_id: "gemma-4-31B-it",
      context_window_tokens: 128_000,
      platform: "custom",
      runtime_supported: true,
    });
  } finally {
    localServer.stop(true);
  }
});

test("hosted model registration uses masked credentials without pre-release migration", async () => {
  process.env.OPENAI_API_KEY = "sk-env-should-not-auto-register-z";
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
  });
  try {
    const initialCatalog = await getJson(`${server.url}model-catalog`);
    expect(initialCatalog.data.registered_models).toEqual([]);
    expect(JSON.stringify(initialCatalog)).not.toContain(
      "sk-env-should-not-auto-register-z",
    );

    const credential = await postJson(
      `${server.url}model-catalog/provider-credentials`,
      {
        provider_id: "openai",
        auth_type: "api_key",
        label: "Personal OpenAI",
        api_key: "sk-hosted-secret-z",
      },
    );
    expect(credential.data.credential).toMatchObject({
      provider_id: "openai",
      auth_type: "api_key",
      label: "Personal OpenAI",
      masked_value: "sk-...z",
    });
    expect(JSON.stringify(credential)).not.toContain("sk-hosted-secret-z");

    const registered = await postJson(
      `${server.url}model-catalog/registered-models`,
      {
        provider_id: "openai",
        model_id: "gpt-5.5",
        auth_type: "api_key",
        credential_id: credential.data.credential.id,
      },
    );
    expect(registered.data.model).toMatchObject({
      provider_id: "openai",
      model_ref: "openai/gpt-5.5",
      auth_type: "api_key",
      credential_id: credential.data.credential.id,
      runtime_supported: true,
    });
    expect(JSON.stringify(registered)).not.toContain("sk-hosted-secret-z");

    const settings = await patchJson(`${server.url}settings`, {
      model: "anthropic/claude-opus-4-7",
      reasoning_effort: "high",
    });
    expect(settings.data.model).toBe("openai/gpt-5.5");
    expect(settings.data.reasoning_effort).toBe("high");

    const catalog = await getJson(`${server.url}model-catalog`);
    const zaiProvider = catalog.data.providers.find(
      (provider: { provider_id: string }) => provider.provider_id === "zai",
    );
    expect(zaiProvider?.default_api_base_url).toBe("https://api.z.ai/api/paas/v4");
    expect(
      catalog.data.registered_models.map(
        (model: { model_ref: string }) => model.model_ref,
      ),
    ).toEqual(["openai/gpt-5.5"]);
    expect(catalog.data.provider_credentials).toContainEqual(
      expect.objectContaining({
        id: credential.data.credential.id,
        provider_id: "openai",
        masked_value: "sk-...z",
      }),
    );
    expect(JSON.stringify(catalog)).not.toContain("sk-hosted-secret-z");
  } finally {
    delete process.env.OPENAI_API_KEY;
    server.stop();
  }
});

test("hosted model registration persists editable provider API base URLs", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
  });
  try {
    const credential = await postJson(
      `${server.url}model-catalog/provider-credentials`,
      {
        provider_id: "zai",
        auth_type: "api_key",
        label: "Z.AI Coding",
        api_key: "zai-secret",
      },
    );
    const registered = await postJson(
      `${server.url}model-catalog/registered-models`,
      {
        provider_id: "zai",
        model_id: "glm-5.2",
        auth_type: "api_key",
        credential_id: credential.data.credential.id,
        api_base_url: "https://api.z.ai/api/coding/paas/v4/",
      },
    );
    expect(registered.data.model).toMatchObject({
      provider_id: "zai",
      model_ref: "zai/glm-5.2",
      api_base_url: "https://api.z.ai/api/coding/paas/v4",
      credential_id: credential.data.credential.id,
    });

    const catalog = await getJson(`${server.url}model-catalog`);
    expect(
      catalog.data.registered_models.find(
        (model: { model_ref: string }) => model.model_ref === "zai/glm-5.2",
      ),
    ).toMatchObject({
      api_base_url: "https://api.z.ai/api/coding/paas/v4",
    });
  } finally {
    server.stop();
  }
});

test("hosted model registration exposes provider auth capability gates", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
  });
  try {
    const catalog = await getJson(`${server.url}model-catalog`);
    const providers = catalog.data.providers as Array<{
      provider_id: string;
      auth_methods?: string[];
    }>;
    expect(
      providers.find((provider) => provider.provider_id === "openai")
        ?.auth_methods,
    ).toEqual(["api_key", "codex_oauth"]);
    expect(
      providers.find((provider) => provider.provider_id === "google")
        ?.auth_methods,
    ).toEqual(["api_key"]);
    expect(
      providers.find((provider) => provider.provider_id === "anthropic")
        ?.auth_methods,
    ).toEqual(["api_key"]);
    expect(
      providers.find((provider) => provider.provider_id === "xai")
        ?.auth_methods,
    ).toEqual(["api_key"]);
    expect(
      providers.find((provider) => provider.provider_id === "qwen")
        ?.auth_methods,
    ).toEqual(["api_key"]);
    expect(
      providers.find((provider) => provider.provider_id === "kimi")
        ?.auth_methods,
    ).toEqual(["api_key"]);
    expect(
      providers.find((provider) => provider.provider_id === "zai")
        ?.auth_methods,
    ).toEqual(["api_key"]);
  } finally {
    server.stop();
  }
});

test("registered local models can be edited and deleted without stale settings refs", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
  });
  try {
    await postJson(`${server.url}model-catalog/local-models`, {
      provider_id: "local",
      api_type: "openai_compatible",
      platform: "llama_cpp",
      server_url: "http://127.0.0.1:8080",
      model_id: "gemma-before",
      display_name: "Gemma Before",
      context_window_tokens: 16_384,
      max_output_tokens: 4_096,
      source: "manual",
    });
    await patchJson(`${server.url}settings`, {
      model: "local/gemma-before",
      reasoning_effort: "none",
      worker_model_rules: [
        {
          id: "local-deep",
          label: "Local deep",
          condition: "Use local before",
          model: "local/gemma-before",
          reasoning_effort: "none",
          enabled: true,
        },
      ],
    });

    const edited = await patchJson(
      `${server.url}model-catalog/local-models/${encodeURIComponent("local/gemma-before")}`,
      {
        provider_id: "local",
        api_type: "openai_compatible",
        platform: "custom",
        server_url: "http://127.0.0.1:9090",
        model_id: "gemma-after",
        display_name: "Gemma After",
        context_window_tokens: 8_192,
        max_output_tokens: 2_048,
        reasoning_budget_ratio: 0.5,
        source: "manual",
      },
    );
    expect(edited.data.model).toMatchObject({
      model_ref: "local/gemma-after",
      display_name: "Gemma After",
      context_window_tokens: 8_192,
      default_reasoning_effort: "high",
      reasoning_efforts: ["none", "high"],
      reasoning_budget_tokens: {
        high: 1024,
      },
      local_reasoning_budget_ratio: 0.5,
      platform: "custom",
    });
    expect(
      edited.data.catalog.models.map(
        (model: { model_ref: string }) => model.model_ref,
      ),
    ).toContain("local/gemma-after");
    expect(
      edited.data.catalog.models.map(
        (model: { model_ref: string }) => model.model_ref,
      ),
    ).not.toContain("local/gemma-before");

    const remappedSettings = await getJson(`${server.url}settings`);
    expect(remappedSettings.data.model).toBe("local/gemma-after");
    expect(remappedSettings.data.worker_model_rules).toContainEqual(
      expect.objectContaining({
        model: "local/gemma-after",
        reasoning_effort: "none",
      }),
    );

    const deleted = await deleteJson(
      `${server.url}model-catalog/local-models/${encodeURIComponent("local/gemma-after")}`,
    );
    expect(deleted.data.removed_model_ref).toBe("local/gemma-after");
    expect(
      deleted.data.catalog.models.map(
        (model: { model_ref: string }) => model.model_ref,
      ),
    ).not.toContain("local/gemma-after");
    const normalizedSettings = await getJson(`${server.url}settings`);
    expect(normalizedSettings.data.model).toBe("openai/gpt-5.5");
    expect(
      JSON.stringify(normalizedSettings.data.worker_model_rules),
    ).not.toContain("local/gemma-after");
  } finally {
    server.stop();
  }
});

test("registered local models cannot be deleted while an active turn uses them", async () => {
  let releaseResponder = () => {};
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
    responder: async () =>
      await new Promise((resolve) => {
        releaseResponder = () => resolve({ texts: ["done"] });
      }),
  });
  try {
    await postJson(`${server.url}model-catalog/local-models`, {
      provider_id: "local",
      api_type: "openai_compatible",
      platform: "llama_cpp",
      server_url: "http://127.0.0.1:8080",
      model_id: "gemma-active",
      display_name: "Gemma Active",
      context_window_tokens: 16_384,
      source: "manual",
    });
    const sendPromise = fetch(`${server.url}messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: "general",
        text: "keep this turn active",
        model: "local/gemma-active",
        reasoning_effort: "none",
      }),
    }).then(async (response) => {
      expect(response.ok).toBe(true);
      return await response.json();
    });
    await waitForTurnState(server.url, "general", "thinking");

    const deletion = await fetch(
      `${server.url}model-catalog/local-models/${encodeURIComponent("local/gemma-active")}`,
      {
        method: "DELETE",
      },
    );
    const deletionBody = await deletion.json();
    expect(deletion.status).toBe(409);
    expect(deletionBody.error.code).toBe("local_model_in_use");

    releaseResponder();
    const sent = await sendPromise;
    expect(sent.data.turn.state).toBe("thinking");
    const assistant = await waitForAssistantMessageMatching(
      server.url,
      "general",
      (message) => message.text === "done",
    );
    expect(assistant.text).toBe("done");
  } finally {
    releaseResponder();
    server.stop();
  }
});

test("session controls and personalization are app-server backed and privacy safe", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
  });
  try {
    const initialControls = await getJson(
      `${server.url}sessions/general/controls`,
    );
    expect(initialControls.data.controls).toMatchObject({
      model: "openai/gpt-5.5",
      reasoning_effort: "xhigh",
      access_mode: "full_access",
      plan_mode: false,
    });

    const updatedControls = await patchJson(
      `${server.url}sessions/general/controls`,
      {
        model: "openai/gpt-5.4-mini",
        reasoning_effort: "medium",
        access_mode: "read_only",
        plan_mode: true,
      },
    );
    expect(updatedControls.data.controls).toMatchObject({
      model: "openai/gpt-5.4-mini",
      reasoning_effort: "medium",
      access_mode: "read_only",
      plan_mode: true,
    });

    const roundTripControls = await getJson(
      `${server.url}sessions/general/controls`,
    );
    expect(roundTripControls.data.controls).toMatchObject(
      updatedControls.data.controls,
    );

    const initialPersonalization = await getJson(
      `${server.url}personalization`,
    );
    expect(initialPersonalization.data.profile).toMatchObject({
      butler_nickname: "",
      principal_name: "",
      preferred_address: "",
      updated_at: null,
      storage_label: "personalization/profile.json",
    });
    expect(initialPersonalization.data.profiling).toMatchObject({
      mode: "off",
      enabled: false,
      storage_label: "cognition/profile/profile.sqlite",
      raw_profile_browser_visible: false,
    });
    expect(
      initialPersonalization.data.persona_presets.map(
        (preset: { name: string }) => preset.name,
      ),
    ).toEqual([
      "butler",
      "guardian",
      "demon-butler",
      "wolf-butler",
      "neko-servant",
      "think-tank",
      "operator",
      "archivist",
      "dry-wit",
    ]);
    const butlerPreset = initialPersonalization.data.persona_presets.find(
      (preset: { name: string }) => preset.name === "butler",
    );
    expect(butlerPreset.content).toContain("name: active");
    expect(butlerPreset.content).toContain("base: butler");
    expect(butlerPreset.content).toContain("base_locale:");
    expect(JSON.stringify(initialPersonalization)).not.toContain(tempDir);

    const migrationPrompt = await getJson(
      `${server.url}personalization/profile-import-prompt?locale=ko`,
    );
    expect(migrationPrompt.data).toMatchObject({
      locale: "ko",
      raw_profile_included: false,
    });
    expect(migrationPrompt.data.prompt).toContain("저장한 모든 기억");
    expect(migrationPrompt.data.prompt).toContain("## Categories");
    expect(migrationPrompt.data.prompt).toContain("## Instructions");
    expect(migrationPrompt.data.prompt).toContain("[YYYY-MM-DD]");
    expect(migrationPrompt.data.prompt).toContain("완전한 전체 목록인지");
    expect(migrationPrompt.data.prompt).toContain("비밀번호");
    expect(migrationPrompt.data.prompt).not.toContain("Butler");

    const skippedMigration = await postJson(
      `${server.url}personalization/profile-import`,
      {
        text: JSON.stringify({
          user_profile_export: {
            current_interests: ["server raw migration sentinel"],
          },
        }),
      },
    );
    expect(skippedMigration.data).toMatchObject({
      profiling_enabled: false,
      source: "external-ai",
      imported_candidate_count: 0,
      model_called: false,
      raw_text_included: false,
    });
    expect(JSON.stringify(skippedMigration)).not.toContain(
      "server raw migration sentinel",
    );

    await patchJson(`${server.url}settings`, { language: "ko" });
    const localizedPersonalization = await getJson(
      `${server.url}personalization`,
    );
    const koNekoPreset = localizedPersonalization.data.persona_presets.find(
      (preset: { name: string }) => preset.name === "neko-servant",
    );
    expect(koNekoPreset.locale).toBe("ko");
    expect(koNekoPreset.preview).toContain("냐");

    const personalization = await patchJson(`${server.url}personalization`, {
      persona: "test persona sentinel",
      eol: "test eol sentinel",
      profile: {
        butler_nickname: "Alfred",
        principal_name: "Bruce Wayne",
        preferred_address: "Master Wayne",
      },
      profiling: {
        mode: "basic",
      },
    });
    expect(personalization.data).toMatchObject({
      persona: "test persona sentinel",
      eol: "test eol sentinel",
      profile: {
        butler_nickname: "Alfred",
        principal_name: "Bruce Wayne",
        preferred_address: "Master Wayne",
        storage_label: "personalization/profile.json",
      },
      profiling: {
        mode: "basic",
        enabled: true,
        storage_label: "cognition/profile/profile.sqlite",
        raw_profile_browser_visible: false,
      },
    });
    expect(JSON.stringify(personalization)).not.toContain(tempDir);
    const storedProfile = JSON.parse(
      readFileSync(join(tempDir, "personalization", "profile.json"), "utf8"),
    );
    expect(storedProfile).toMatchObject({
      butler_nickname: "Alfred",
      principal_name: "Bruce Wayne",
      preferred_address: "Master Wayne",
    });

    const roundTripPersonalization = await getJson(
      `${server.url}personalization`,
    );
    expect(roundTripPersonalization.data).toMatchObject({
      persona: personalization.data.persona,
      eol: personalization.data.eol,
      profile: {
        butler_nickname: "Alfred",
        principal_name: "Bruce Wayne",
        preferred_address: "Master Wayne",
        storage_label: "personalization/profile.json",
      },
      profiling: {
        mode: "basic",
        enabled: true,
        storage_label: "cognition/profile/profile.sqlite",
      },
    });
    expect(
      Date.parse(roundTripPersonalization.data.updated_at),
    ).toBeGreaterThanOrEqual(Date.parse(personalization.data.updated_at));
    expect(JSON.stringify(roundTripPersonalization)).not.toContain(tempDir);

    await patchJson(`${server.url}personalization`, {
      persona: "updated persona sentinel",
      eol: "updated eol sentinel",
      profiling: {
        clear_profile: true,
      },
    });
    const backupDir = join(tempDir, "personalization", "backups");
    const backups = readdirSync(backupDir).sort();
    expect(backups.some((name) => name.startsWith("persona-active-"))).toBe(
      true,
    );
    expect(backups.some((name) => name.startsWith("eol-"))).toBe(true);
    expect(
      readFileSync(
        join(
          backupDir,
          backups.find((name) => name.startsWith("persona-active-"))!,
        ),
        "utf8",
      ),
    ).toBe("test persona sentinel");
  } finally {
    server.stop();
  }
});

test("app server defaults Butler data to BUTLER_DATA before the home fallback", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
  });
  try {
    await patchJson(`${server.url}personalization`, {
      persona: "env-scoped persona sentinel",
      eol: "env-scoped eol sentinel",
    });
    expect(readFileSync(join(tempDir, "personas", "active.md"), "utf8")).toBe(
      "env-scoped persona sentinel",
    );
    expect(readFileSync(join(tempDir, "eol.md"), "utf8")).toBe(
      "env-scoped eol sentinel",
    );
  } finally {
    server.stop();
  }
});

test("folder selection tokens expire before project or settings mutation", async () => {
  const folderSelectionSecret = "test-folder-selection-secret";
  const selectedFolder = join(tempDir, "expired-selected-project");
  mkdirSync(selectedFolder, { recursive: true });
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    folderSelectionSecret,
    port: 0,
  });
  try {
    const expired = createProjectFolderSelectionToken(
      selectedFolder,
      folderSelectionSecret,
      {
        nowMs: Date.now() - 10_000,
        ttlMs: 1,
      },
    );
    const projectResponse = await fetch(`${server.url}projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        source: "existing_folder",
        folder_selection_token: expired,
      }),
    });
    const projectBody = await projectResponse.json();
    expect(projectResponse.status).toBe(400);
    expect(projectBody.error.code).toBe("folder_selection_expired");

    const settingsResponse = await fetch(`${server.url}settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        default_project_folder_selection_token: expired,
      }),
    });
    const settingsBody = await settingsResponse.json();
    expect(settingsResponse.status).toBe(400);
    expect(settingsBody.error.code).toBe("folder_selection_expired");
    expect(JSON.stringify(settingsBody)).not.toContain(tempDir);
  } finally {
    server.stop();
  }
});

test("settings default project folder updates from signed desktop selection and persists", async () => {
  const folderSelectionSecret = "test-folder-selection-secret";
  const dbPath = join(tempDir, "app.sqlite");
  const selectedDefault = join(tempDir, "selected-default-workspace");
  mkdirSync(selectedDefault, { recursive: true });
  const server = createAppServer({
    dbPath,
    folderSelectionSecret,
    port: 0,
  });
  try {
    const token = createProjectFolderSelectionToken(
      selectedDefault,
      folderSelectionSecret,
    );
    const updated = await patchJson(`${server.url}settings`, {
      default_project_folder_selection_token: token,
    });
    expect(updated.data.default_project_workspace_label).toBe(
      "selected-default-workspace",
    );
    const project = await postJson(`${server.url}projects`, {
      source: "scratch",
    });
    expect(project.data.project.workspace_label).toBe("New project");
    expect(existsSync(join(selectedDefault, "New project"))).toBe(true);
    expect(JSON.stringify(updated)).not.toContain(tempDir);
  } finally {
    server.stop();
  }

  const restarted = createAppServer({
    dbPath,
    folderSelectionSecret,
    port: 0,
  });
  try {
    const settings = await getJson(`${restarted.url}settings`);
    expect(settings.data.default_project_workspace_label).toBe(
      "selected-default-workspace",
    );
  } finally {
    restarted.stop();
  }
});

test("session summary and context details expose aggregate app data without raw prompts", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
    responder(input) {
      return { texts: [`reply: ${input.text}`] };
    },
  });
  try {
    await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "private summary sentinel",
    });
    const summary = await getJson(
      `${server.url}session-summary?session_id=general`,
    );
    expect(summary.data.session_id).toBe("general");
    expect(summary.data.latest_progress.state).toBe("delivered");
    expect(summary.data.latest_progress.safe_progress_rows).toEqual([]);
    expect(summary.data.skills_used).toEqual([]);
    expect(summary.data.context_details.used_tokens).toBeGreaterThan(0);
    expect(summary.data.branch_info.safe_status).toBe("No project workspace");
    expect(JSON.stringify(summary)).not.toContain("private summary sentinel");
    expect(JSON.stringify(summary)).not.toContain(tempDir);

    const context = await getJson(
      `${server.url}context-details?session_id=general`,
    );
    expect(
      context.data.categories.map(
        (category: { source_kind: string }) => category.source_kind,
      ),
    ).toEqual(
      expect.arrayContaining([
        "static_context",
        "live_configuration",
        "runtime_state",
        "working_context",
        "current_input",
        "compaction_reserve",
      ]),
    );
    expect(context.data.available_working_context_tokens).toBeGreaterThan(0);
    expect(JSON.stringify(context)).not.toContain("private summary sentinel");

    const exported = await getJson(
      `${server.url}transcript-export?session_id=general`,
    );
    expect(exported.data).toMatchObject({
      session_id: "general",
      format: "markdown",
      message_count: 2,
    });
    expect(exported.data.content).toContain("private summary sentinel");
  } finally {
    server.stop();
  }
});

test("context details reflect latest provider prompt usage telemetry", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
    responder(input) {
      return { texts: [`reply: ${input.text}`] };
    },
  });
  try {
    const sent = await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "small visible request",
    });
    const turnId = sent.data.accepted.turn_id as string;
    const before = await getJson(
      `${server.url}context-details?session_id=general`,
    );

    appendPromptCacheMetric(
      {
        ts: Date.now(),
        model: "openai/gpt-5.4",
        scope: "session-turn",
        turnId,
        phase: "tool_loop",
        promptTokens: 64_000,
        cachedTokens: 8_000,
        totalTokens: 65_500,
      },
      { butlerData: tempDir },
    );

    const after = await getJson(
      `${server.url}context-details?session_id=general`,
    );
    const working = after.data.categories.find(
      (category: { id: string }) => category.id === "working",
    );

    expect(before.data.used_tokens).toBeLessThan(64_000);
    expect(after.data.used_tokens).toBeGreaterThanOrEqual(64_000);
    expect(after.data.token_count_source).toBe("provider_prompt_usage");
    expect(working.used_tokens).toBeGreaterThan(before.data.used_tokens);
    expect(JSON.stringify(after)).not.toContain("small visible request");
  } finally {
    server.stop();
  }
});

test("context details fall back to latest context monitor runtime telemetry", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
    responder(input) {
      return { texts: [`reply: ${input.text}`] };
    },
  });
  try {
    await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "small visible request",
    });
    const before = await getJson(
      `${server.url}context-details?session_id=general`,
    );

    appendRuntimeTurnContextMetric({
      butlerData: tempDir,
      sessionId: "butler/app-general",
      model: "openai/gpt-5.4",
      totalPromptChars: 300_000,
      promptContextChars: 280_000,
      recentConversationChars: 20_000,
      recallContextChars: 40_000,
      inboundMessageChars: 120,
    });

    const after = await getJson(
      `${server.url}context-details?session_id=general`,
    );

    expect(before.data.used_tokens).toBeLessThan(60_000);
    expect(after.data.used_tokens).toBeGreaterThanOrEqual(60_000);
    expect(after.data.token_count_source).toBe("context_monitor");
    expect(JSON.stringify(after)).not.toContain("small visible request");
  } finally {
    server.stop();
  }
});

test("session summary shows only prompt-loaded skills from context metadata", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
    responder() {
      return { texts: [] };
    },
  });
  try {
    const session = await postJson(`${server.url}sessions`, {
      kind: "chat",
      title: "skill summary",
      session_hint: "skill-summary",
    });
    const chatId = session.data.session.id;
    const runtimeSessionId = session.data.session.session_hint;
    const result = await postJson(`${server.url}messages`, {
      chat_id: chatId,
      text: "status",
    });
    const turnId = result.data.turn.id;
    appendTranscriptEvent(
      createTranscriptEvent({
        sessionId: runtimeSessionId,
        kind: "system",
        timestamp: "2026-05-18T12:00:00.000Z",
        payload: {
          category: "context.skills.loaded",
          details: {
            turnId,
            skillNames: ["status"],
          },
        },
        metadata: {
          turnId,
          source: "test",
        },
      }),
    );

    const view = await getJson(
      `${server.url}session-view?session_id=${chatId}`,
    );
    expect(view.data.skills_used).toEqual(["status"]);
    expect(JSON.stringify(view)).not.toContain("butler-ship-feature");
    expect(JSON.stringify(view)).not.toContain("restart");
  } finally {
    server.stop();
  }
});

test("session summary does not synthesize delivered turn history as progress rows", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
    responder(input) {
      return { texts: [`reply: ${input.text}`] };
    },
  });
  try {
    await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "first no-tool prompt",
    });
    await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "second no-tool prompt",
    });

    const summary = await getJson(
      `${server.url}session-summary?session_id=general`,
    );

    expect(summary.data.latest_progress.state).toBe("delivered");
    expect(summary.data.latest_progress.safe_progress_rows).toEqual([]);
  } finally {
    server.stop();
  }
});

test("session summary exposes active WorkStreams without raw work internals", async () => {
  const store = new WorkStreamStore(tempDir);
  store.updateFromTodoList({
    ownerSessionId: "butler/app-general",
    projectId: "butler",
    listId: "main",
    title: "Ship WorkStream FSM",
    items: [
      {
        id: "intent",
        content: "Frame intent",
        active_form: "Framing intent",
        status: "completed",
        phase: "conception",
        priority: "normal",
        blocked_by: [],
        note: null,
        created_at: "2026-05-15T00:00:00.000Z",
        updated_at: "2026-05-15T00:00:00.000Z",
        completed_at: "2026-05-15T00:00:00.000Z",
      },
      {
        id: "plan",
        content: "Plan implementation",
        active_form: "Planning implementation",
        status: "in_progress",
        phase: "planning",
        priority: "normal",
        blocked_by: [],
        note: null,
        created_at: "2026-05-15T00:00:00.000Z",
        updated_at: "2026-05-15T00:00:00.000Z",
        completed_at: null,
      },
    ],
  });
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
  });
  try {
    const summary = await getJson(
      `${server.url}session-summary?session_id=general`,
    );
    expect(summary.data.work_streams).toEqual([
      expect.objectContaining({
        title: "Ship WorkStream FSM",
        project_id: "butler",
        state: "planning",
        current_phase: "planning",
        active_step_id: "plan",
        terminal: false,
      }),
    ]);
    expect(JSON.stringify(summary.data.work_streams)).not.toContain(
      "raw prompt",
    );
  } finally {
    server.stop();
  }
});

test("session summary excludes recoverable WorkStreams from active projection", async () => {
  const store = new WorkStreamStore(tempDir);
  const stream = store.updateFromTodoList({
    ownerSessionId: "butler/app-general",
    projectId: "butler",
    listId: "recoverable-main",
    title: "Recover interrupted work",
    items: [
      {
        id: "code",
        content: "Implement recovery path",
        active_form: "Implementing recovery path",
        status: "in_progress",
        phase: "execution",
        priority: "normal",
        blocked_by: [],
        note: null,
        created_at: "2026-05-15T00:00:00.000Z",
        updated_at: "2026-05-15T00:00:00.000Z",
        completed_at: null,
      },
    ],
  });
  store.transition({
    id: stream.id,
    state: "recoverable",
    statusNote: "Interrupted before final delivery.",
  });
  expect(store.list({ sessionId: "butler/app-general" })).toContainEqual(
    expect.objectContaining({ id: stream.id, state: "recoverable" }),
  );

  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
  });
  try {
    const summary = await getJson(
      `${server.url}session-summary?session_id=general`,
    );
    expect(summary.data.work_streams).toEqual([]);
  } finally {
    server.stop();
  }
});

test("terminal app turn state reconciles matching turn-local WorkStreams", async () => {
  const streamStore = new WorkStreamStore(tempDir);
  const todoStore = new TodoListStore(tempDir);
  let streamId = "";
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
    responder(input) {
      const todoView = todoStore.update({
        listId: "terminal-turn-local",
        items: [
          {
            id: "report",
            content: "Report completion",
            active_form: "Reporting completion",
            status: "in_progress",
            phase: "reporting",
            priority: "normal",
            blocked_by: [],
          },
        ],
      });
      const stream = streamStore.updateFromTodoList({
        ownerSessionId: "butler/app-general",
        listId: "terminal-turn-local",
        lastUserTurnId: input.turnId,
        items: todoView.list.items,
      });
      streamId = stream.id;
      return { texts: [`reply: ${input.text}`] };
    },
  });
  try {
    await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "finish active work",
    });

    expect(streamStore.read(streamId)).toMatchObject({
      state: "complete",
      status_note: "Reconciled after delivered turn replay.",
    });
  } finally {
    server.stop();
  }
});

test("session summary and view do not mutate stale terminal WorkStreams on read", async () => {
  const streamStore = new WorkStreamStore(tempDir);
  const todoStore = new TodoListStore(tempDir);
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
    responder(input) {
      return { texts: [`reply: ${input.text}`] };
    },
  });
  try {
    const result = await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "already delivered",
    });
    const turnId = result.data.turn.id as string;
    const todoView = todoStore.update({
      listId: "late-stale-turn-local",
      items: [
        {
          id: "code",
          content: "Keep this active until a terminal write occurs",
          active_form: "Keeping stale active work",
          status: "in_progress",
          phase: "execution",
          priority: "normal",
          blocked_by: [],
        },
      ],
    });
    const stream = streamStore.updateFromTodoList({
      ownerSessionId: "butler/app-general",
      listId: "late-stale-turn-local",
      lastUserTurnId: turnId,
      items: todoView.list.items,
    });
    expect(streamStore.read(stream.id)?.state).toBe("executing");

    await getJson(`${server.url}session-summary?session_id=general`);
    await getJson(`${server.url}session-view?session_id=general`);

    expect(streamStore.read(stream.id)).toMatchObject({
      state: "executing",
      active_step_id: "code",
    });
  } finally {
    server.stop();
  }
});

test("message replay does not mutate stale terminal WorkStreams on read", async () => {
  const streamStore = new WorkStreamStore(tempDir);
  const todoStore = new TodoListStore(tempDir);
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
  });
  try {
    const internalStore = server.store as unknown as {
      insertTurn(chatId: string, state: string, label: string): { id: string };
      updateTurnState(
        turnId: string,
        state: string,
        options: { safeStatusLabel: string; cancellable?: boolean },
      ): void;
      insertMessage(
        chatId: string,
        role: string,
        text: string,
        status: string,
        options?: { turnId?: string | null },
      ): void;
    };
    const turn = internalStore.insertTurn("general", "accepted", "Accepted");
    internalStore.updateTurnState(turn.id, "delivered", {
      safeStatusLabel: "Delivered",
      cancellable: false,
    });
    internalStore.insertMessage(
      "general",
      "assistant",
      "already delivered",
      "delivered",
      { turnId: turn.id },
    );
    const todoView = todoStore.update({
      listId: "message-read-stale-turn-local",
      items: [
        {
          id: "inspect",
          content: "Remain unchanged during message replay",
          active_form: "Remaining unchanged during message replay",
          status: "in_progress",
          phase: "execution",
          priority: "normal",
          blocked_by: [],
        },
      ],
    });
    const stream = streamStore.updateFromTodoList({
      ownerSessionId: "butler/app-general",
      listId: "message-read-stale-turn-local",
      lastUserTurnId: turn.id,
      items: todoView.list.items,
    });

    await getJson(`${server.url}messages?chat_id=general`);

    expect(streamStore.read(stream.id)).toMatchObject({
      state: "executing",
      active_step_id: "inspect",
    });
    expect(todoStore.view("message-read-stale-turn-local", { includeCompleted: true }).progress.active)
      .toBe(1);
  } finally {
    server.stop();
  }
});

test("session summary and view keep current-turn waiting WorkStreams active only for that turn", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
  });
  try {
    const internalStore = server.store as unknown as {
      insertTurn(chatId: string, state: string, label: string): { id: string };
      updateTurnState(
        turnId: string,
        state: string,
        options: { safeStatusLabel: string; cancellable?: boolean },
      ): void;
    };
    const historicalTurn = internalStore.insertTurn("general", "accepted", "Accepted");
    internalStore.updateTurnState(historicalTurn.id, "delivered", {
      safeStatusLabel: "Delivered",
      cancellable: false,
    });
    const currentTurn = internalStore.insertTurn("general", "accepted", "Accepted");
    internalStore.updateTurnState(currentTurn.id, "waiting_for_tool", {
      safeStatusLabel: "Waiting for a decision",
      cancellable: true,
    });
    const store = new WorkStreamStore(tempDir);
    const historical = store.updateFromTodoList({
      ownerSessionId: "butler/app-general",
      projectId: "butler",
      listId: "waiting-historical",
      title: "Historical waiting work",
      lastUserTurnId: historicalTurn.id,
      items: [
        {
          id: "historical",
          content: "Wait from an earlier turn",
          active_form: "Waiting from an earlier turn",
          status: "in_progress",
          phase: "planning",
          priority: "normal",
          blocked_by: [],
          note: null,
          created_at: "2026-05-15T00:00:00.000Z",
          updated_at: "2026-05-15T00:00:00.000Z",
          completed_at: null,
        },
      ],
    });
    store.transition({ id: historical.id, state: "waiting_user" });
    const current = store.updateFromTodoList({
      ownerSessionId: "butler/app-general",
      projectId: "butler",
      listId: "waiting-current",
      title: "Current waiting work",
      lastUserTurnId: currentTurn.id,
      items: [
        {
          id: "current",
          content: "Wait for current turn decision",
          active_form: "Waiting for current turn decision",
          status: "in_progress",
          phase: "planning",
          priority: "normal",
          blocked_by: [],
          note: null,
          created_at: "2026-05-15T00:00:00.000Z",
          updated_at: "2026-05-15T00:00:00.000Z",
          completed_at: null,
        },
      ],
    });
    store.transition({ id: current.id, state: "waiting_user" });

    const summary = await getJson(
      `${server.url}session-summary?session_id=general`,
    );
    expect(summary.data.work_streams).toEqual([
      expect.objectContaining({
        id: current.id,
        title: "Current waiting work",
        state: "waiting_user",
      }),
    ]);

    const view = await getJson(
      `${server.url}session-view?session_id=general`,
    );
    expect(view.data.work_streams).toEqual([
      expect.objectContaining({
        id: current.id,
        title: "Current waiting work",
        state: "waiting_user",
      }),
    ]);
  } finally {
    server.stop();
  }
});

test("session replay hides terminal turn-local WorkStreams without mutating todos", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
  });
  try {
    const internalStore = server.store as unknown as {
      insertTurn(chatId: string, state: string, label: string): { id: string };
      updateTurnState(
        turnId: string,
        state: string,
        options: { safeStatusLabel: string; cancellable?: boolean },
      ): void;
    };
    const turn = internalStore.insertTurn("general", "accepted", "Accepted");
    internalStore.updateTurnState(turn.id, "delivered", {
      safeStatusLabel: "Delivered",
      cancellable: false,
    });
    const todoStore = new TodoListStore(tempDir);
    const todoView = todoStore.update({
      listId: "stale-replay-work",
      items: [
        {
          id: "inspect",
          content: "Inspect stale replay state",
          active_form: "Inspecting stale replay state",
          status: "in_progress",
          phase: "execution",
        },
        {
          id: "report",
          content: "Report stale replay state",
          active_form: "Reporting stale replay state",
          status: "pending",
          phase: "reporting",
        },
      ],
    });
    const stream = new WorkStreamStore(tempDir).updateFromTodoList({
      ownerSessionId: "butler/app-general",
      listId: "stale-replay-work",
      title: "Stale replay work",
      lastUserTurnId: turn.id,
      items: todoView.list.items,
    });

    const summary = await getJson(
      `${server.url}session-summary?session_id=general`,
    );
    expect(summary.data.work_streams).toEqual([]);
    expect(new TodoListStore(tempDir).view("stale-replay-work", { includeCompleted: true }).progress.active)
      .toBe(2);
    expect(new WorkStreamStore(tempDir).read(stream.id)).toMatchObject({
      state: "executing",
      current_phase: "execution",
      active_step_id: "inspect",
    });

    const view = await getJson(
      `${server.url}session-view?session_id=general`,
    );
    expect(view.data.work_streams).toEqual([]);
  } finally {
    server.stop();
  }
});

test("session replay hides stale work from older terminal turns without mutating it", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
  });
  try {
    const internalStore = server.store as unknown as {
      insertTurn(chatId: string, state: string, label: string): { id: string };
      updateTurnState(
        turnId: string,
        state: string,
        options: { safeStatusLabel: string; cancellable?: boolean },
      ): void;
    };
    const oldTurn = internalStore.insertTurn("general", "accepted", "Accepted");
    internalStore.updateTurnState(oldTurn.id, "delivered", {
      safeStatusLabel: "Delivered",
      cancellable: false,
    });
    const latestTurn = internalStore.insertTurn("general", "accepted", "Accepted");
    internalStore.updateTurnState(latestTurn.id, "thinking", {
      safeStatusLabel: "Thinking",
      cancellable: true,
    });
    const todoView = new TodoListStore(tempDir).update({
      listId: "older-stale-replay-work",
      items: [
        {
          id: "inspect",
          content: "Inspect older stale replay state",
          active_form: "Inspecting older stale replay state",
          status: "in_progress",
          phase: "execution",
        },
      ],
    });
    const stream = new WorkStreamStore(tempDir).updateFromTodoList({
      ownerSessionId: "butler/app-general",
      listId: "older-stale-replay-work",
      title: "Older stale replay work",
      lastUserTurnId: oldTurn.id,
      items: todoView.list.items,
    });

    const summary = await getJson(
      `${server.url}session-summary?session_id=general`,
    );
    expect(summary.data.turn_state).toBe("thinking");
    expect(summary.data.work_streams).toEqual([]);
    expect(new WorkStreamStore(tempDir).read(stream.id)).toMatchObject({
      state: "executing",
      current_phase: "execution",
      active_step_id: "inspect",
    });
    expect(new TodoListStore(tempDir).view("older-stale-replay-work", { includeCompleted: true }).progress.active)
      .toBe(1);

    const view = await getJson(
      `${server.url}session-view?session_id=general`,
    );
    expect(view.data.work_streams).toEqual([]);
  } finally {
    server.stop();
  }
});

test("session replay preserves recoverable stale WorkStreams as recovery history", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
  });
  try {
    const internalStore = server.store as unknown as {
      insertTurn(chatId: string, state: string, label: string): { id: string };
      updateTurnState(
        turnId: string,
        state: string,
        options: { safeStatusLabel: string; cancellable?: boolean },
      ): void;
    };
    const turn = internalStore.insertTurn("general", "accepted", "Accepted");
    internalStore.updateTurnState(turn.id, "delivered", {
      safeStatusLabel: "Delivered",
      cancellable: false,
    });
    const todoView = new TodoListStore(tempDir).update({
      listId: "stale-recoverable-work",
      items: [
        {
          id: "resume",
          content: "Resume stale recoverable state",
          active_form: "Resuming stale recoverable state",
          status: "cancelled",
          phase: "execution",
        },
      ],
    });
    const store = new WorkStreamStore(tempDir);
    const stream = store.updateFromTodoList({
      ownerSessionId: "butler/app-general",
      listId: "stale-recoverable-work",
      title: "Stale recoverable work",
      lastUserTurnId: turn.id,
      items: todoView.list.items,
    });
    store.transition({
      id: stream.id,
      state: "recoverable",
      statusNote: "Recoverable before replay.",
    });

    const summary = await getJson(
      `${server.url}session-summary?session_id=general`,
    );
    expect(summary.data.work_streams).toEqual([]);
    expect(new WorkStreamStore(tempDir).read(stream.id)).toMatchObject({
      state: "recoverable",
      status_note: "Recoverable before replay.",
    });
  } finally {
    server.stop();
  }
});

test("automations expose prompt bodies only in detail and can run while paused", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
    responder() {
      return { texts: ["automation reply"] };
    },
  });
  try {
    const created = await postJson(`${server.url}automations`, {
      title: "Status check",
      prompt_body: "private automation prompt sentinel",
      target_session_id: "general",
      interval_seconds: 600,
    });
    const automationId = created.data.automation.id;

    const list = await getJson(`${server.url}automations`);
    expect(list.data.automations[0]).toMatchObject({
      id: automationId,
      title: "Status check",
      interval_label: "10 minutes",
    });
    expect(JSON.stringify(list)).not.toContain(
      "private automation prompt sentinel",
    );

    const detail = await getJson(
      `${server.url}automations/${encodeURIComponent(automationId)}`,
    );
    expect(detail.data.automation.prompt_body).toBe(
      "private automation prompt sentinel",
    );

    await postJson(
      `${server.url}automations/${encodeURIComponent(automationId)}/pause`,
      {},
    );
    const run = await postJson(
      `${server.url}automations/${encodeURIComponent(automationId)}/run`,
      {},
    );
    expect(run.data.run.state).toBe("succeeded");
    expect(run.data.automation.state).toBe("paused");

    const runs = await getJson(
      `${server.url}automations/${encodeURIComponent(automationId)}/runs`,
    );
    expect(runs.data.runs[0]).toMatchObject({
      state: "succeeded",
      trigger: "run_now",
    });
    expect(JSON.stringify(runs)).not.toContain(
      "private automation prompt sentinel",
    );
  } finally {
    server.stop();
  }
});

test("automation scheduler dispatches due enabled automations", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
    automationSchedulerIntervalMs: 20,
    responder() {
      return { texts: ["scheduled automation reply"] };
    },
  });
  try {
    const created = await postJson(`${server.url}automations`, {
      title: "Scheduled status",
      prompt_body: "scheduled private prompt",
      target_session_id: "general",
      interval_seconds: 600,
    });
    const automationId = created.data.automation.id;
    server.store.db
      .query("UPDATE app_automations SET next_run_at = ? WHERE id = ?")
      .run(new Date(0).toISOString(), automationId);

    const runs = await waitForAutomationRun(server.url, automationId);
    expect(runs.data.runs[0]).toMatchObject({
      state: "succeeded",
      trigger: "scheduled",
    });
    expect(JSON.stringify(runs)).not.toContain("scheduled private prompt");
  } finally {
    server.stop();
  }
});

test("automation scheduler drains queued prompts after a busy session becomes idle", async () => {
  const seenTexts: string[] = [];
  let releaseBlocking: (() => void) | undefined;
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
    responder(input) {
      seenTexts.push(input.text);
      if (input.text === "blocking turn") {
        return new Promise((resolve) => {
          releaseBlocking = () => resolve({ texts: ["blocking reply"] });
        });
      }
      return { texts: ["queued automation reply"] };
    },
  });
  try {
    const pendingResponse = fetch(`${server.url}messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: "general",
        text: "blocking turn",
      }),
    });
    await waitForTurnState(server.url, "general", "thinking");

    const created = await postJson(`${server.url}automations`, {
      title: "Queued status",
      prompt_body: "private queued automation prompt",
      target_session_id: "general",
      interval_seconds: 600,
    });
    const automationId = created.data.automation.id;
    server.store.db
      .query("UPDATE app_automations SET next_run_at = ? WHERE id = ?")
      .run(new Date(0).toISOString(), automationId);

    const queued = await postJson(`${server.url}automations/dispatch-due`, {});
    expect(queued.data.runs[0]).toMatchObject({
      state: "queued",
      trigger: "scheduled",
    });
    const queuedMessageId = queued.data.runs[0].queued_message_id;
    expect(typeof queuedMessageId).toBe("string");

    const messagesWhileBusy = await getJson(
      `${server.url}messages?chat_id=general`,
    );
    expect(
      messagesWhileBusy.data.messages.find(
        (message: { id: string }) => message.id === queuedMessageId,
      ),
    ).toMatchObject({
      role: "automation",
      text: "Automation prompt queued.",
      status: "pending",
    });

    releaseBlocking?.();
    const pending = await pendingResponse;
    expect(pending.ok).toBe(true);

    const drained = await postJson(`${server.url}automations/dispatch-due`, {});
    expect(drained.data.runs[0]).toMatchObject({
      id: queued.data.runs[0].id,
      state: "succeeded",
    });
    expect(seenTexts).toContain("private queued automation prompt");

    const runs = await getJson(
      `${server.url}automations/${encodeURIComponent(automationId)}/runs`,
    );
    expect(runs.data.runs[0]).toMatchObject({
      id: queued.data.runs[0].id,
      state: "succeeded",
      queued_message_id: queuedMessageId,
    });
    expect(JSON.stringify(runs)).not.toContain(
      "private queued automation prompt",
    );

    const messagesAfterDrain = await getJson(
      `${server.url}messages?chat_id=general`,
    );
    expect(
      messagesAfterDrain.data.messages.find(
        (message: { id: string }) => message.id === queuedMessageId,
      ),
    ).toMatchObject({
      text: "Automation prompt dispatched.",
      status: "delivered",
    });
  } finally {
    releaseBlocking?.();
    server.stop();
  }
});

test("worker activity projects durable worker state without raw worker requests", async () => {
  const tasksDir = join(tempDir, "tasks", "20260501010101");
  let sleeper: ReturnType<typeof spawn> | undefined;
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(tasksDir, "status"), "RUNNING\n", "utf8");
  writeFileSync(
    join(tasksDir, "request.md"),
    "private worker request sentinel\n",
    "utf8",
  );
  writeFileSync(join(tasksDir, "log.txt"), "still running\n", "utf8");
  writeFileSync(
    join(tasksDir, "worker_activity.json"),
    JSON.stringify({
      phase: "planning",
      status_line: "Planning: Making plan for background task.",
      current_title: "Choosing the worker step path.",
      updated_at: "2026-05-01T00:00:00.000Z",
      work_blocks: [
        {
          id: "worker-shell-call-1",
          label: "Checking the file list.",
          state: "delivered",
          rows: [
            {
              id: "worker-shell-call-1-command",
              kind: "read",
              state: "delivered",
              safe_label: "Bash: rg --files",
              safe_tool_name: "Bash",
              safe_input_label: "rg --files",
              work_block_id: "worker-shell-call-1",
              work_block_label: "Checking the file list.",
            },
          ],
        },
      ],
    }),
    "utf8",
  );

  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
  });
  try {
    const workers = await getJson(
      `${server.url}worker-activity?include_history=true`,
    );
    expect(workers.data.workers[0]).toMatchObject({
      worker_id: "worker-20260501010101",
      activity_kind: "worker",
      worker_label: "Worker 1",
      worker_display_name: "Juno",
      worker_ordinal_label: "Worker 1",
      phase: "planning",
      objective: "Background worker task",
      status_line: "Planning: Making plan for background task.",
      current_activity_title: "Choosing the worker step path.",
      terminal: false,
    });
    expect(workers.data.workers[0].work_blocks).toMatchObject([
      {
        id: "worker-shell-call-1",
        label: "Checking the file list.",
        rows: [{ safe_tool_name: "Bash", safe_input_label: "rg --files" }],
      },
    ]);
    expect(JSON.stringify(workers)).not.toContain(
      "private worker request sentinel",
    );

    sleeper = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
    if (!sleeper.pid) throw new Error("sleep process did not start");
    const runningSleeper = sleeper;
    writeFileSync(join(tasksDir, "pid"), `${runningSleeper.pid}\n`, "utf8");
    writeFileSync(join(tasksDir, "pgid"), `${runningSleeper.pid}\n`, "utf8");
    runningSleeper.unref();
    const control = await postJson(
      `${server.url}worker-activity/worker-20260501010101/control`,
      {
        action: "cancel",
      },
    );
    expect(control.data.notice).toBeUndefined();
    expect(control.data.worker).toMatchObject({
      phase: "cancelled",
      terminal: true,
    });
    expect(readFileSync(join(tasksDir, "status"), "utf8").trim()).toBe(
      "KILLED",
    );
    expect(JSON.stringify(control)).not.toContain("received cancel");
    await waitForCondition(
      () =>
        runningSleeper.exitCode !== null || runningSleeper.signalCode !== null,
    );
  } finally {
    if (
      sleeper?.pid &&
      sleeper.exitCode === null &&
      sleeper.signalCode === null
    ) {
      try {
        process.kill(-sleeper.pid, "SIGKILL");
      } catch {
        // Best-effort cleanup for failed assertions.
      }
    }
    server.stop();
  }
});

test("worker activity projects reporting phase from durable state", async () => {
  const tasksDir = join(tempDir, "tasks", "20260502020202");
  mkdirSync(tasksDir, { recursive: true });
  writeFileSync(join(tasksDir, "status"), "RUNNING\n", "utf8");
  writeFileSync(
    join(tasksDir, "worker_activity.json"),
    JSON.stringify({
      phase: "reporting",
      status_line: "Reporting: preparing reviewed result.",
      updated_at: "2026-05-02T00:00:00.000Z",
    }),
    "utf8",
  );

  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
  });
  try {
    const workers = await getJson(
      `${server.url}worker-activity?include_history=true`,
    );
    expect(workers.data.workers[0]).toMatchObject({
      worker_id: "worker-20260502020202",
      activity_kind: "worker",
      worker_label: "Worker 1",
      worker_display_name: "Ivy",
      worker_ordinal_label: "Worker 1",
      phase: "reporting",
      status_line: "Reporting: preparing reviewed result.",
      terminal: false,
    });
  } finally {
    server.stop();
  }
});

test("worker activity cancel stops planned orchestration and linked worker task", async () => {
  const planned = new PlannedTaskStore(tempDir);
  planned.create({
    task_id: "planned-cancel",
    type: "planned",
    goal: "Investigate project",
    project: "NanaChanAI",
    created_at: "2026-05-16T00:00:00.000Z",
    decision_policy: "autonomous",
    acceptance_criteria: ["Worker can be cancelled"],
    verification_commands: [],
    review_policy: "review evidence",
    repair_policy: {
      max_attempts: 0,
      allow_autonomous_repair: false,
    },
    public_report_policy: "report only reviewed evidence",
  });
  planned.transition("planned-cancel", "PLANNED_RUNNING");
  planned.writeAttemptDispatch("planned-cancel", 1, {
    worker_task_id: "worker-child-cancel",
    prompt: "private planned worker prompt",
  });
  const childDir = join(tempDir, "tasks", "worker-child-cancel");
  mkdirSync(childDir, { recursive: true });
  writeFileSync(join(childDir, "status"), "RUNNING\n", "utf8");
  writeFileSync(
    join(childDir, "request.md"),
    "private planned worker prompt\n",
    "utf8",
  );

  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
  });
  try {
    const control = await postJson(
      `${server.url}worker-activity/worker-planned-cancel/control`,
      {
        action: "cancel",
      },
    );
    expect(control.data.notice).toBeUndefined();
    expect(control.data.worker).toMatchObject({
      activity_kind: "planned",
      phase: "cancelled",
      terminal: true,
    });
    expect(planned.read("planned-cancel")?.status).toBe("CANCELLED");
    expect(readFileSync(join(childDir, "status"), "utf8").trim()).toBe(
      "KILLED",
    );
  } finally {
    server.stop();
  }
});

test("session worker activity links planned orchestration rows with worker attempts", async () => {
  const planned = new PlannedTaskStore(tempDir);
  planned.create({
    task_id: "planned-session-worker-panel",
    type: "planned",
    goal: "Investigate the project safely",
    project: tempDir,
    created_at: "2026-05-15T00:00:00.000Z",
    decision_policy: "autonomous",
    acceptance_criteria: ["worker attempt is visible under the plan"],
    verification_commands: [],
    review_policy: "review all criteria",
    repair_policy: { max_attempts: 1, allow_autonomous_repair: true },
    public_report_policy: "brief report",
  });
  planned.writeAttemptDispatch("planned-session-worker-panel", 1, {
    worker_task_id: "worker-session-panel",
    prompt: "do planned work",
  });
  planned.transition("planned-session-worker-panel", "PLANNED_RUNNING");
  for (let index = 0; index < 30; index += 1) {
    planned.create({
      task_id: `zz-noise-${String(index).padStart(2, "0")}`,
      type: "planned",
      goal: "Old unrelated planned task",
      project: tempDir,
      created_at: "2026-05-14T00:00:00.000Z",
      decision_policy: "autonomous",
      acceptance_criteria: ["unrelated"],
      verification_commands: [],
      review_policy: "review all criteria",
      repair_policy: { max_attempts: 0, allow_autonomous_repair: false },
      public_report_policy: "none",
    });
  }
  const origin = buildTaskOriginContext({
    sessionId: "butler/app-project-panel",
    taskSummary: "Investigate the project safely",
    project: "project-panel",
  });
  new TaskStore(tempDir).writeOrigin("planned-session-worker-panel", origin);

  const workerDir = join(tempDir, "tasks", "worker-session-panel");
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(join(workerDir, "status"), "RUNNING\n", "utf8");
  writeFileSync(
    join(workerDir, "worker_activity.json"),
    JSON.stringify({
      phase: "consolidating",
      status_line: "Consolidating: reading worker evidence.",
      updated_at: "2026-05-15T00:00:00.000Z",
    }),
    "utf8",
  );
  new TaskStore(tempDir).writeOrigin("worker-session-panel", origin);

  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
  });
  try {
    server.store.createSession({
      kind: "chat",
      title: "Panel session",
      session_hint: "project-panel",
    });
    const summary = await getJson(
      `${server.url}session-summary?session_id=project-panel`,
    );
    expect(
      summary.data.worker_activity.map(
        (worker: { worker_label: string }) => worker.worker_label,
      ),
    ).toEqual(["Plan", "Worker 1"]);
    expect(summary.data.worker_activity[0]).toMatchObject({
      activity_kind: "planned",
      task_id: "planned-session-worker-panel",
      orchestration_id: "planned-session-worker-panel",
    });
    expect(summary.data.worker_activity[1]).toMatchObject({
      activity_kind: "worker",
      task_id: "worker-session-panel",
      orchestration_id: "planned-session-worker-panel",
      worker_display_name: "Leo",
      worker_ordinal_label: "Worker 1",
      phase: "consolidating",
    });
  } finally {
    server.stop();
  }
});

test("session worker activity synthesizes planned parent for orphan work orchestration streams", async () => {
  const origin = buildTaskOriginContext({
    sessionId: "btcc-panel",
    taskSummary: "Ship the projection fix",
    project: "project-btcc",
  });
  const orchestrationStore = new WorkOrchestrationStore(tempDir);
  orchestrationStore.create({
    id: "orch-btcc-projection",
    title: "Projection closeout",
    goal: "Project BTCC worker streams in the app panel",
    originSessionId: "btcc-panel",
    streams: [{
      id: "implementation",
      role: "builder",
      objective: "Implement worker activity projection",
      acceptance_criteria: ["details are visible"],
    }],
    now: new Date("2026-05-16T00:00:00.000Z"),
  });
  orchestrationStore.markDispatched(
    "orch-btcc-projection",
    [{ stream_id: "implementation", worker_task_id: "worker-btcc-projection" }],
    new Date("2026-05-16T00:01:00.000Z"),
  );

  const workerDir = join(tempDir, "tasks", "worker-btcc-projection");
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(join(workerDir, "status"), "RUNNING\n", "utf8");
  writeFileSync(join(workerDir, "request.md"), "private raw worker request sentinel\n", "utf8");
  writeFileSync(
    join(workerDir, "worker_activity.json"),
    JSON.stringify({
      phase: "executing",
      status_line: "Executing: worker implementation is running.",
      current_title: "Applying projection changes.",
      updated_at: "2026-05-16T00:02:00.000Z",
    }),
    "utf8",
  );
  writeFileSync(
    join(workerDir, "worker_activity_events.jsonl"),
    [
      {
        schema: "butler.worker-activity-event.v1",
        event_id: "ev-decision",
        created_at: "2026-05-16T00:02:01.000Z",
        actor: "worker",
        event: "activity_updated",
        semantic_phase: "executing",
        action_kind: "run_command",
        status_line: "Executing: inspecting projection code.",
        current_title: "Inspecting projection code.",
        decision_summary: "Inspect existing worker activity projection.",
        decision_rationale: "The UI already groups planned parents with worker children.",
        decision_next_step: "Add the missing backend parent and details projection.",
        decision_source: "assistant-authored",
        evidence_refs: ["store.ts projection"],
        work_block_id: "worker-timeline-call-1",
        raw_prompt: "unsafe raw prompt sentinel",
      },
      {
        schema: "butler.worker-activity-event.v1",
        event_id: "ev-secret",
        created_at: "2026-05-16T00:02:02.000Z",
        actor: "worker",
        event: "activity_updated",
        semantic_phase: "executing",
        action_kind: "run_command",
        status_line: "Executing: token=unsafe-secret should not leak.",
        current_title: "Running local inspection.",
        decision_summary: "<think>hidden reasoning sentinel</think>",
        decision_rationale: "sessionId unsafe internal sentinel",
        decision_next_step: "Continue safely.",
        decision_source: "runtime-derived",
        evidence_refs: ["safe evidence ref", "authorization: bearer unsafe-token"],
        work_block_id: "worker-timeline-call-2",
      },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );
  writeFileSync(join(workerDir, "session_id"), "worker-btcc-session\n", "utf8");
  const transcriptDir = join(tempDir, "transcripts");
  mkdirSync(transcriptDir, { recursive: true });
  writeFileSync(
    join(transcriptDir, "worker_worker-btcc-session.jsonl"),
    [
      {
        eventId: "tr-decision",
        kind: "system",
        timestamp: "2026-05-16T00:02:03.000Z",
        payload: {
          category: "public_work_decision",
          decision: {
            decisionId: "decision-run-focused-test",
            decisionSummary: "Run a focused app-server projection test.",
            decisionRationale: "A route-level fixture proves SessionView receives safe worker details.",
            decisionNextStep: "Assert the worker block and no unsafe fields leak.",
            decisionSource: "assistant-authored",
            decisionEvidenceRefs: ["app-server worker activity test"],
          },
        },
      },
      {
        eventId: "tr-tool-call",
        kind: "tool_call",
        timestamp: "2026-05-16T00:02:04.000Z",
        payload: {
          id: "tool-transcript-1",
          name: "run_command",
          arguments: {
            command: "cd /Users/example/butler && bun test tests/unit/app-server.test.ts",
            cwd: "/Users/example/butler",
          },
          raw_payload: "unsafe provider payload sentinel",
        },
      },
      {
        eventId: "tr-tool-result",
        kind: "tool_result",
        timestamp: "2026-05-16T00:02:05.000Z",
        payload: {
          tool_call_id: "tool-transcript-1",
          name: "run_command",
          result: {
            command: "cd /Users/example/butler && bun test tests/unit/app-server.test.ts",
            cwd: "/Users/example/butler",
            exit_code: 0,
            stdout: "unsafe full raw log sentinel",
          },
          publicDecision: {
            decisionId: "decision-run-focused-test",
            decisionSummary: "Run a focused app-server projection test.",
            decisionRationale: "A route-level fixture proves SessionView receives safe worker details.",
            decisionNextStep: "Assert the worker block and no unsafe fields leak.",
            decisionSource: "assistant-authored",
            decisionEvidenceRefs: ["app-server worker activity test"],
          },
        },
      },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n",
    "utf8",
  );
  new TaskStore(tempDir).writeOrigin("worker-btcc-projection", origin);

  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
  });
  try {
    server.store.createSession({
      kind: "chat",
      title: "BTCC panel",
      session_hint: "btcc-panel",
    });
    const summary = await getJson(
      `${server.url}session-summary?session_id=btcc-panel`,
    );
    expect(
      summary.data.worker_activity.map(
        (worker: { activity_kind: string; task_id?: string; orchestration_id?: string }) =>
          `${worker.activity_kind}:${worker.task_id ?? worker.orchestration_id}`,
      ),
    ).toEqual([
      "planned:orch-btcc-projection",
      "worker:worker-btcc-projection",
    ]);
    expect(summary.data.worker_activity[0]).toMatchObject({
      activity_kind: "planned",
      task_id: "orch-btcc-projection",
      orchestration_id: "orch-btcc-projection",
      objective: "Project BTCC worker streams in the app panel",
      terminal: false,
    });
    expect(summary.data.worker_activity[1]).toMatchObject({
      activity_kind: "worker",
      orchestration_id: "orch-btcc-projection",
    });
    const projectedBlock = summary.data.worker_activity[1].work_blocks.find(
      (block: { id: string }) => block.id === "worker-timeline-call-1",
    );
    expect(projectedBlock).toMatchObject({
      id: "worker-timeline-call-1",
      decision_summary: "Inspect existing worker activity projection.",
      decision_rationale: "The UI already groups planned parents with worker children.",
      decision_next_step: "Add the missing backend parent and details projection.",
      rows: [{
        kind: "run_command",
        safe_label: "Inspecting projection code.",
        safe_tool_name: "Worker timeline",
        safe_input_label: "Executing: inspecting projection code.",
      }],
    });
    const transcriptDecisionBlock = summary.data.worker_activity[1].work_blocks.find(
      (block: { decision_summary?: string }) =>
        block.decision_summary === "Run a focused app-server projection test.",
    );
    expect(transcriptDecisionBlock).toMatchObject({
      decision_rationale: "A route-level fixture proves SessionView receives safe worker details.",
      decision_next_step: "Assert the worker block and no unsafe fields leak.",
    });
    expect(transcriptDecisionBlock).toMatchObject({
      id: "worker-transcript-decision-decision-run-focused-test",
      rows: expect.arrayContaining([
        expect.objectContaining({
          kind: "ran_command",
          safe_label: "Bash",
          safe_tool_name: "Bash",
          safe_input_label: "cd ~/butler && bun test tests/unit/app-server.test.ts",
          safe_detail_rows: expect.arrayContaining([
            expect.objectContaining({
              safe_label: "Command",
              safe_value: "cd ~/butler && bun test tests/unit/app-server.test.ts",
            }),
          ]),
          created_at: "2026-05-16T00:02:04.000Z",
        }),
        expect.objectContaining({
          kind: "ran_command",
          safe_label: "Bash",
          safe_tool_name: "Bash",
          safe_input_label: "cd ~/butler && bun test tests/unit/app-server.test.ts",
          safe_detail_rows: expect.arrayContaining([
            expect.objectContaining({
              safe_label: "Exit",
              safe_value: "0",
            }),
          ]),
          created_at: "2026-05-16T00:02:05.000Z",
        }),
      ]),
    });
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("Recorded worker decision.");
    expect(serialized).not.toContain("Started run_command.");
    expect(serialized).not.toContain("private raw worker request sentinel");
    expect(serialized).not.toContain("unsafe raw prompt sentinel");
    expect(serialized).not.toContain("hidden reasoning sentinel");
    expect(serialized).not.toContain("runtime-derived");
    expect(serialized).not.toContain("Continue safely.");
    expect(serialized).not.toContain("unsafe-secret");
    expect(serialized).not.toContain("unsafe-token");
    expect(serialized).not.toContain("sessionId unsafe internal sentinel");
    expect(serialized).not.toContain("unsafe provider payload sentinel");
    expect(serialized).not.toContain("unsafe full raw log sentinel");
  } finally {
    server.stop();
  }
});

test("session worker activity disambiguates duplicate worker display names", async () => {
  const taskStore = new TaskStore(tempDir);
  for (const [taskId, taskSummary] of [
    ["worker-task-9", "First colliding worker"],
    ["worker-task-23", "Second colliding worker"],
  ] as const) {
    const workerDir = join(tempDir, "tasks", taskId);
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, "status"), "RUNNING\n", "utf8");
    writeFileSync(join(workerDir, "request.md"), `${taskSummary}\n`, "utf8");
    writeFileSync(
      join(workerDir, "worker_activity.json"),
      JSON.stringify({
        phase: "executing",
        status_line: `Executing: ${taskSummary}.`,
        updated_at: "2026-05-16T00:02:00.000Z",
      }),
      "utf8",
    );
    taskStore.writeOrigin(taskId, buildTaskOriginContext({
      sessionId: "display-collision-panel",
      taskSummary,
      project: "project-btcc",
    }));
  }

  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
  });
  try {
    server.store.createSession({
      kind: "chat",
      title: "Display collision panel",
      session_hint: "display-collision-panel",
    });
    const summary = await getJson(
      `${server.url}session-summary?session_id=display-collision-panel`,
    );
    const displayNames = summary.data.worker_activity.map(
      (worker: { worker_display_name: string }) => worker.worker_display_name,
    );

    expect(displayNames).toContain("Rina");
    expect(displayNames).not.toContain("Rina (Worker 2)");
    expect(displayNames.every((name: string) => !/\(Worker \d+\)$/u.test(name))).toBe(true);
    expect(new Set(displayNames).size).toBe(displayNames.length);
  } finally {
    server.stop();
  }
});

test("session worker activity keeps display names unique beyond the base name pool", async () => {
  const taskStore = new TaskStore(tempDir);
  const workerCount = 15;
  for (let index = 0; index < workerCount; index += 1) {
    const taskId = `worker-roster-${String(index).padStart(2, "0")}`;
    const workerDir = join(tempDir, "tasks", taskId);
    mkdirSync(workerDir, { recursive: true });
    writeFileSync(join(workerDir, "status"), "RUNNING\n", "utf8");
    writeFileSync(join(workerDir, "request.md"), `Roster worker ${index}\n`, "utf8");
    writeFileSync(
      join(workerDir, "worker_activity.json"),
      JSON.stringify({
        phase: "executing",
        status_line: `Executing: roster worker ${index}.`,
        updated_at: `2026-05-16T00:03:${String(index).padStart(2, "0")}.000Z`,
      }),
      "utf8",
    );
    taskStore.writeOrigin(taskId, buildTaskOriginContext({
      sessionId: "large-worker-roster-panel",
      taskSummary: `Roster worker ${index}`,
      project: "project-btcc",
    }));
  }

  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
  });
  try {
    server.store.createSession({
      kind: "chat",
      title: "Large worker roster panel",
      session_hint: "large-worker-roster-panel",
    });
    const summary = await getJson(
      `${server.url}session-summary?session_id=large-worker-roster-panel`,
    );
    const displayNames = summary.data.worker_activity.map(
      (worker: { worker_display_name: string }) => worker.worker_display_name,
    );

    expect(displayNames).toHaveLength(workerCount);
    expect(new Set(displayNames).size).toBe(displayNames.length);
    expect(displayNames.every((name: string) => !/\(Worker \d+\)$/u.test(name))).toBe(true);
  } finally {
    server.stop();
  }
});

test("session worker history keeps blocked plan parent while active summary excludes it", async () => {
  const origin = buildTaskOriginContext({
    sessionId: "blocked-plan-panel",
    taskSummary: "Prepare blocked orchestration evidence",
    project: "project-btcc",
  });
  const orchestrationStore = new WorkOrchestrationStore(tempDir);
  orchestrationStore.create({
    id: "orch-blocked-plan",
    title: "Blocked plan",
    goal: "Show a blocked plan state when a worker stream fails before dependents run",
    originSessionId: "blocked-plan-panel",
    streams: [
      {
        id: "setup",
        role: "builder",
        objective: "Prepare setup evidence.",
        acceptance_criteria: ["Implementation evidence exists"],
      },
      {
        id: "implementation",
        role: "builder",
        objective: "Implement after setup.",
        acceptance_criteria: ["Implementation is complete"],
        depends_on: ["setup"],
      },
    ],
    now: new Date("2026-05-16T00:00:00.000Z"),
  });
  orchestrationStore.markDispatched(
    "orch-blocked-plan",
    [{ stream_id: "setup", worker_task_id: "worker-blocked-plan" }],
    new Date("2026-05-16T00:01:00.000Z"),
  );
  const orchestrationPath = join(tempDir, "orchestrations", "orch-blocked-plan.json");
  const orchestrationRecord = JSON.parse(readFileSync(orchestrationPath, "utf8")) as {
    status: string;
    streams: Array<{ id: string; status: string; result_summary?: string | null }>;
  };
  orchestrationRecord.status = "running";
  orchestrationRecord.streams = orchestrationRecord.streams.map((stream) =>
    stream.id === "setup"
      ? {
          ...stream,
          status: "failed",
          result_summary: "Worker recorded an explicit blocker; report the blocker, not completion.",
        }
      : stream,
  );
  writeFileSync(orchestrationPath, JSON.stringify(orchestrationRecord, null, 2), "utf8");

  const workerDir = join(tempDir, "tasks", "worker-blocked-plan");
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(join(workerDir, "status"), "DONE\n", "utf8");
  writeFileSync(join(workerDir, "request.md"), "Plan the setup work.\n", "utf8");
  writeFileSync(join(workerDir, "result.md"), "I planned the setup work.\n", "utf8");
  writeFileSync(
    join(workerDir, "worker_activity_events.jsonl"),
    `${JSON.stringify({
      schema: "butler.worker-activity-event.v1",
      event_id: "ev-blocked-plan",
      created_at: "2026-05-16T00:02:00.000Z",
      actor: "worker",
      event: "activity_updated",
      semantic_phase: "planning",
      action_kind: "plan",
      status_line: "Planning: identified setup work.",
    })}\n`,
    "utf8",
  );
  new TaskStore(tempDir).writeOrigin("worker-blocked-plan", origin);

  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
  });
  try {
    server.store.createSession({
      kind: "chat",
      title: "Blocked plan panel",
      session_hint: "blocked-plan-panel",
    });
    const history = await getJson(
      `${server.url}sessions/blocked-plan-panel/worker-activity/history`,
    );
    const blockedPlan = history.data.workers.find(
      (worker: { task_id: string }) =>
        worker.task_id === "orch-blocked-plan",
    );
    expect(blockedPlan).toMatchObject({
      activity_kind: "planned",
      task_id: "orch-blocked-plan",
      orchestration_id: "orch-blocked-plan",
      phase: "blocked",
      terminal: false,
      status_line: "Blocked: 1 of 2 worker streams failed; remaining streams are waiting.",
    });
    const summary = await getJson(
      `${server.url}session-summary?session_id=blocked-plan-panel`,
    );
    expect(summary.data.worker_activity).toEqual([]);
    const view = await getJson(
      `${server.url}session-view?session_id=blocked-plan-panel`,
    );
    expect(view.data.workers).toEqual([]);
    expect(orchestrationStore.read("orch-blocked-plan")).toMatchObject({
      status: "running",
      streams: [
        expect.objectContaining({ id: "setup", status: "failed" }),
        expect.objectContaining({ id: "implementation", status: "pending" }),
      ],
    });
  } finally {
    server.stop();
  }
});

test("session worker history keeps worker-failed planned task while active summary excludes it", async () => {
  const taskId = "planned-worker-failed-active-scope";
  const sessionId = "planned-worker-failed-panel";
  const planned = new PlannedTaskStore(tempDir);
  planned.create({
    task_id: taskId,
    type: "planned",
    goal: "Investigate a stale recoverable task without showing it as active.",
    project: tempDir,
    created_at: "2026-05-16T00:00:00.000Z",
    origin_session_id: sessionId,
    decision_policy: "autonomous",
    acceptance_criteria: ["The stale task remains inspectable only as history"],
    verification_commands: [],
    review_policy: "review all criteria",
    repair_policy: { max_attempts: 1, allow_autonomous_repair: true },
    public_report_policy: "brief reviewed report",
  });
  planned.transition(taskId, "PLANNED_RUNNING");
  planned.transition(taskId, "WORKER_FAILED");
  new TaskStore(tempDir).writeOrigin(
    taskId,
    buildTaskOriginContext({
      sessionId,
      taskSummary: "Stale recoverable planned task",
      project: null,
      createdAt: "2026-05-16T00:00:00.000Z",
    }),
  );

  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
  });
  try {
    server.store.createSession({
      kind: "chat",
      title: "Planned worker failed panel",
      session_hint: sessionId,
    });
    const summary = await getJson(
      `${server.url}session-summary?session_id=${sessionId}`,
    );
    expect(summary.data.worker_activity).toEqual([]);

    const view = await getJson(
      `${server.url}session-view?session_id=${sessionId}`,
    );
    expect(
      view.data.workers.find((worker: { task_id: string }) =>
        worker.task_id === taskId,
      ),
    ).toBeUndefined();

    const activeWorkers = await getJson(`${server.url}worker-activity`);
    expect(
      activeWorkers.data.workers.map(
        (worker: { task_id: string }) => worker.task_id,
      ),
    ).not.toContain(taskId);

    const history = await getJson(
      `${server.url}worker-activity?include_history=true`,
    );
    expect(
      history.data.workers.find((worker: { task_id: string }) =>
        worker.task_id === taskId,
      ),
    ).toMatchObject({
      phase: "recoverable",
      terminal: false,
    });
  } finally {
    server.stop();
  }
});

test("session worker history keeps stale executing orchestration while active session view excludes it", async () => {
  const sessionId = "stale-executing-panel";
  const orchestrationStore = new WorkOrchestrationStore(tempDir);
  orchestrationStore.create({
    id: "orch-stale-executing",
    title: "Stale executing plan",
    goal: "Keep stale executing worker history inspectable without showing it as active",
    originSessionId: sessionId,
    streams: [
      {
        id: "implementation",
        role: "builder",
        objective: "Implement stale work.",
        acceptance_criteria: ["Implementation eventually completes"],
      },
    ],
    now: new Date("2026-05-16T00:00:00.000Z"),
  });
  orchestrationStore.markDispatched(
    "orch-stale-executing",
    [{ stream_id: "implementation", worker_task_id: "worker-stale-executing" }],
    new Date("2026-05-16T00:01:00.000Z"),
  );
  const workerDir = join(tempDir, "tasks", "worker-stale-executing");
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(join(workerDir, "status"), "DONE\n", "utf8");
  writeFileSync(join(workerDir, "request.md"), "Implement stale work.\n", "utf8");
  writeFileSync(join(workerDir, "result.md"), "Partial result from an old worker.\n", "utf8");
  writeFileSync(
    join(workerDir, "worker_activity_events.jsonl"),
    `${JSON.stringify({
      schema: "butler.worker-activity-event.v1",
      event_id: "ev-stale-executing",
      created_at: "2026-05-16T00:02:00.000Z",
      actor: "worker",
      event: "activity_updated",
      semantic_phase: "executing",
      action_kind: "edit",
      status_line: "Executing: stale work was once running.",
    })}\n`,
    "utf8",
  );
  new TaskStore(tempDir).writeOrigin(
    "worker-stale-executing",
    buildTaskOriginContext({
      sessionId,
      taskSummary: "Stale executing worker",
      project: null,
      createdAt: "2026-05-16T00:00:00.000Z",
    }),
  );

  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
  });
  try {
    server.store.createSession({
      kind: "chat",
      title: "Stale executing panel",
      session_hint: sessionId,
    });

    const view = await getJson(
      `${server.url}session-view?session_id=${sessionId}`,
    );
    expect(view.data.workers).toEqual([]);

    const activeWorkers = await getJson(
      `${server.url}sessions/${sessionId}/worker-activity`,
    );
    expect(activeWorkers.data.workers).toEqual([]);

    const history = await getJson(
      `${server.url}sessions/${sessionId}/worker-activity/history`,
    );
    expect(
      history.data.workers.find((worker: { task_id: string }) =>
        worker.task_id === "orch-stale-executing",
      ),
    ).toMatchObject({
      phase: "executing",
      terminal: false,
    });
  } finally {
    server.stop();
  }
});

test("app-server read routes do not execute app-origin worker completions", async () => {
  const planned = new PlannedTaskStore(tempDir);
  planned.create({
    task_id: "planned-read-route-no-authority",
    type: "planned",
    goal: "Read APIs must not review worker evidence",
    project: tempDir,
    created_at: "2026-05-19T00:00:00.000Z",
    origin_session_id: "butler/app-general",
    decision_policy: "autonomous",
    acceptance_criteria: ["completion is handled by Butler Agent"],
    verification_commands: [],
    review_policy: "review all criteria",
    repair_policy: { max_attempts: 1, allow_autonomous_repair: true },
    public_report_policy: "brief reviewed report",
  });
  planned.writeAttemptDispatch("planned-read-route-no-authority", 1, {
    worker_task_id: "worker-read-route-no-authority",
    prompt: "do app-origin planned work",
  });
  planned.transition("planned-read-route-no-authority", "PLANNED_RUNNING");
  new TaskStore(tempDir).writeOrigin(
    "planned-read-route-no-authority",
    buildTaskOriginContext({
      sessionId: "butler/app-general",
      taskSummary: "App-origin planned task",
      project: null,
    }),
  );

  const workerDir = join(tempDir, "tasks", "worker-read-route-no-authority");
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(join(workerDir, "status"), "DONE\n", "utf8");
  writeFileSync(
    join(workerDir, "result.md"),
    "worker evidence ready\n",
    "utf8",
  );
  new TaskStore(tempDir).writeOrigin(
    "worker-read-route-no-authority",
    buildTaskOriginContext({
      sessionId: "butler/app-general",
      taskSummary: "App-origin worker",
      project: null,
    }),
  );

  const responderInputs: string[] = [];
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
    responder: (input) => {
      responderInputs.push(input.text);
      return { texts: ["read route should not call this responder"] };
    },
  });
  try {
    await getJson(`${server.url}session-summary?session_id=general`);
    await getJson(`${server.url}messages?chat_id=general`);
    await getJson(
      `${server.url}worker-activity?session_id=general&include_history=true`,
    );
    await getJson(`${server.url}events?cursor=0`);

    expect(responderInputs).toEqual([]);
    expect(planned.read("planned-read-route-no-authority")?.status).toBe(
      "PLANNED_RUNNING",
    );
    const messages = await getJson(`${server.url}messages?chat_id=general`);
    expect(JSON.stringify(messages.data.messages)).not.toContain(
      "worker evidence ready",
    );
  } finally {
    server.stop();
  }
});

test("session view does not sync linked orchestration workers while reading", async () => {
  const orchestrationStore = new WorkOrchestrationStore(tempDir);
  orchestrationStore.create({
    id: "orch-session-view",
    goal: "Build a small canvas game",
    originSessionId: "butler/app-general",
    streams: [{
      id: "implementation",
      role: "builder",
      objective: "Implement the game",
      acceptance_criteria: ["snake.html exists"],
    }],
  });
  orchestrationStore.markDispatched("orch-session-view", [{
    stream_id: "implementation",
    worker_task_id: "worker-orch-session-view",
  }]);
  const workStreamStore = new WorkStreamStore(tempDir);
  workStreamStore.updateFromTodoList({
    ownerSessionId: "butler/app-general",
    projectId: "general",
    listId: "main",
    title: "Build a small canvas game",
    items: [{
      id: "orchestrate",
      content: "Run orchestration",
      active_form: "Running orchestration",
      status: "in_progress",
      phase: "planning",
      priority: "normal",
      blocked_by: [],
      note: null,
      created_at: "2026-05-15T00:00:00.000Z",
      updated_at: "2026-05-15T00:00:00.000Z",
      completed_at: null,
    }],
  });
  workStreamStore.link({
    sessionId: "butler/app-general",
    orchestrationIds: ["orch-session-view"],
    workerTaskIds: ["worker-orch-session-view"],
  });

  const workerDir = join(tempDir, "tasks", "worker-orch-session-view");
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(join(workerDir, "status"), "DONE\n", "utf8");
  writeFileSync(join(workerDir, "project"), "general\n", "utf8");
  writeFileSync(join(workerDir, "request.md"), "Implement the snake game\n", "utf8");
  writeFileSync(join(workerDir, "result.md"), "Created snake.html and verified game behavior.\n", "utf8");
  writeFileSync(join(workerDir, "worker_activity.json"), JSON.stringify({
    phase: "complete",
    semantic_phase: "verifying",
    action_kind: "test",
    status_line: "Complete: worker result is ready.",
    updated_at: "2026-05-15T00:00:00.000Z",
  }), "utf8");
  writeFileSync(join(workerDir, "worker_activity_events.jsonl"), `${JSON.stringify({
    schema: "butler.worker-activity-event.v1",
    event_id: "ev-orch-session-view",
    created_at: "2026-05-15T00:00:00.000Z",
    actor: "worker",
    event: "activity_updated",
    semantic_phase: "executing",
    action_kind: "write_file",
    status_line: "Executing: created snake.html.",
    evidence_refs: ["snake.html"],
  })}\n`, "utf8");

  const responderInputs: string[] = [];
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
    responder: (input) => {
      responderInputs.push(input.text);
      return { texts: ["read route should not call this responder"] };
    },
  });
  try {
    const view = await getJson(`${server.url}session-view?session_id=general`);
    expect(view.data.workers).toEqual([]);
    expect(orchestrationStore.read("orch-session-view")).toMatchObject({
      status: "running",
      streams: [expect.objectContaining({
        id: "implementation",
        status: "running",
      })],
    });
    expect(responderInputs).toEqual([]);
    expect(JSON.stringify(view.data.messages)).not.toContain("Created snake.html");
  } finally {
    server.stop();
  }
});

test("session summary reconciles orphaned system responder turns after public report delivery", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
  });
  try {
    const internalStore = server.store as unknown as {
      insertTurn(chatId: string, state: string, label: string): { id: string };
      updateTurnState(
        turnId: string,
        state: string,
        options: { safeStatusLabel: string; cancellable?: boolean },
      ): void;
      insertMessage(
        chatId: string,
        role: string,
        text: string,
        status: string,
        options?: { turnId?: string | null },
      ): void;
    };
    const turn = internalStore.insertTurn("general", "accepted", "Accepted");
    internalStore.updateTurnState(turn.id, "thinking", {
      safeStatusLabel: "Thinking",
      cancellable: true,
    });
    internalStore.insertMessage(
      "general",
      "assistant",
      "검토된 공개 보고입니다.",
      "delivered",
      { turnId: null },
    );

    const summary = await getJson(
      `${server.url}session-summary?session_id=general`,
    );
    expect(summary.data.turn_state).toBe("delivered");
    expect(summary.data.latest_progress.state).toBe("delivered");
    expect(summary.data.latest_progress.safe_progress_rows).toEqual([]);
  } finally {
    server.stop();
  }
});

test("worker display names stay tied to worker ids when the active roster changes", async () => {
  const taskStore = new TaskStore(tempDir);
  const origin = buildTaskOriginContext({
    sessionId: "stable-session",
    taskSummary: "Keep worker identity stable",
    project: null,
  });
  const firstDir = join(tempDir, "tasks", "20260501010103");
  const secondDir = join(tempDir, "tasks", "20260501010102");
  for (const taskDir of [firstDir, secondDir]) {
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status"), "RUNNING\n", "utf8");
    writeFileSync(
      join(taskDir, "worker_activity.json"),
      JSON.stringify({
        phase: "executing",
        status_line: "Executing: worker is active.",
        updated_at: "2026-05-15T00:00:00.000Z",
      }),
      "utf8",
    );
  }
  taskStore.writeOrigin("20260501010103", origin);
  taskStore.writeOrigin("20260501010102", origin);

  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
  });
  try {
    const initial = await getJson(`${server.url}worker-activity`);
    const secondInitial = initial.data.workers.find(
      (worker: { task_id: string }) => worker.task_id === "20260501010102",
    );
    expect(secondInitial).toMatchObject({
      worker_label: "Worker 2",
      worker_display_name: "Theo",
      worker_ordinal_label: "Worker 2",
    });

    writeFileSync(join(firstDir, "status"), "DONE\n", "utf8");
    const updated = await getJson(`${server.url}worker-activity`);
    expect(updated.data.workers).toHaveLength(1);
    expect(updated.data.workers[0]).toMatchObject({
      task_id: "20260501010102",
      worker_label: "Worker 1",
      worker_display_name: "Theo",
      worker_ordinal_label: "Worker 1",
    });
  } finally {
    server.stop();
  }
});

test("session summaries show only workers that belong to the active session", async () => {
  function writeTask(
    taskId: string,
    status: string,
    originSessionId?: string,
    project?: string | null,
  ) {
    const taskDir = join(tempDir, "tasks", taskId);
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, "status"), `${status}\n`, "utf8");
    writeFileSync(
      join(taskDir, "request.md"),
      `private request ${taskId}\n`,
      "utf8",
    );
    if (project)
      writeFileSync(join(taskDir, "project"), `${project}\n`, "utf8");
    if (originSessionId) {
      writeFileSync(
        join(taskDir, "origin.json"),
        `${JSON.stringify(
          {
            version: 1,
            origin_session_id: originSessionId,
            origin_message_id: `message-${taskId}`,
            origin_inbound_event_id: `event-${taskId}`,
            task_summary: `Safe worker summary ${taskId}`,
            created_at: "2026-05-01T00:00:00.000Z",
            project: project ?? null,
            topic_summary: null,
            transcript_ref: {
              session_id: originSessionId,
              path: `data/transcripts/${originSessionId}.jsonl`,
              origin_event_id: `event-${taskId}`,
              origin_message_id: `message-${taskId}`,
              recent_event_ids: [`event-${taskId}`],
            },
            memory_refs: [],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
    }
  }

  writeTask("20260501010103", "RUNNING", "general", null);
  const workspaceRoot = join(tempDir, "worker-project-workspace");
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    projectWorkspaceRoot: workspaceRoot,
    port: 0,
  });
  try {
    const createdProject = await postJson(`${server.url}projects`, {
      source: "scratch",
      display_name: "Worker project",
    });
    const projectId = createdProject.data.project.id as string;
    const projectSession = await postJson(`${server.url}sessions`, {
      kind: "project",
      project_id: projectId,
      title: "Worker project session",
      session_hint: "project-butler",
    });
    const projectSessionId = projectSession.data.session.id as string;
    writeTask("20260501010102", "RUNNING", projectSessionId, projectId);
    writeTask("20260501010101", "RUNNING");
    writeTask("20260501010100", "FAILED", undefined, projectId);
    writeTask("20260501010099", "RUNNING", undefined, projectId);
    writeTask("20260501010104", "DONE", projectSessionId, projectId);

    const general = await getJson(
      `${server.url}session-summary?session_id=general`,
    );
    expect(
      general.data.worker_activity.map(
        (worker: { task_id: string }) => worker.task_id,
      ),
    ).toEqual(["20260501010103"]);
    expect(general.data.worker_activity[0]).toMatchObject({
      session_id: "general",
      objective: "Safe worker summary 20260501010103",
    });
    expect(general.data.worker_activity[0].project_id).toBeUndefined();

    const projectSummary = await getJson(
      `${server.url}session-summary?session_id=${projectSessionId}`,
    );
    expect(
      projectSummary.data.worker_activity.map(
        (worker: { task_id: string }) => worker.task_id,
      ),
    ).toEqual(["20260501010102"]);
    expect(projectSummary.data.worker_activity[0]).toMatchObject({
      session_id: projectSessionId,
      project_id: projectId,
      objective: "Safe worker summary 20260501010102",
    });

    const global = await getJson(
      `${server.url}worker-activity?include_history=true`,
    );
    expect(
      global.data.workers.map((worker: { task_id: string }) => worker.task_id),
    ).toEqual([
      "20260501010104",
      "20260501010103",
      "20260501010102",
      "20260501010101",
      "20260501010100",
      "20260501010099",
    ]);
    const completed = global.data.workers.find(
      (worker: { task_id: string }) => worker.task_id === "20260501010104",
    );
    expect(completed).toMatchObject({
      phase: "verifying",
      terminal: true,
      supported_controls: [],
    });
    expect(JSON.stringify(general)).not.toContain("private request");
    expect(JSON.stringify(projectSummary)).not.toContain("private request");
  } finally {
    server.stop();
  }
});

test("posted messages persist and replay after restart", async () => {
  const dbPath = join(tempDir, "app.sqlite");
  let server = createAppServer({ dbPath, port: 0 });
  const url = server.url;
  const result = await postJson(`${url}messages`, {
    chat_id: "general",
    text: "hello butler",
    client_message_id: "client-11111111-1111-4111-8111-111111111111",
  });
  expect(result.data.accepted.text).toBe("hello butler");
  expect(result.data.accepted.id).toBe(
    "client-11111111-1111-4111-8111-111111111111",
  );
  expect(result.data.accepted.status).toBe("sent");
  expect(result.data.replies).toHaveLength(0);
  expect(result.data.reply).toBeUndefined();
  expect(result.data.turn.state).toBe("thinking");
  expect(result.data.turn.cancellable).toBe(true);
  const pending = readdirSync(
    join(tempDir, "runtime", "inbound-events", "pending"),
  );
  expect(pending).toHaveLength(1);
  const replay = await getJson(`${url}events?cursor=0`);
  const queuedEvent = replay.data.events.find(
    (event: { type: string; payload?: { turn_id?: string } }) =>
      event.type === "turn.queued" &&
      event.payload?.turn_id === result.data.turn.id,
  );
  expect(queuedEvent?.payload?.queue_id).toBeString();
  expect(pending).toEqual([`${queuedEvent.payload.queue_id}.json`]);
  server.stop();

  server = createAppServer({ dbPath, port: 0 });
  try {
    const messages = await getJson(
      `${server.url}messages?chat_id=general&cursor=0`,
    );
    expect(
      messages.data.messages.map((message: { text: string }) => message.text),
    ).toEqual(["hello butler"]);
    expect(
      messages.data.messages.every(
        (message: { turn_id?: string }) => typeof message.turn_id === "string",
      ),
    ).toBe(true);

    const turns = await getJson(`${server.url}turns?chat_id=general&cursor=0`);
    expect(turns.data.turns).toHaveLength(1);
    expect(turns.data.turns[0]).toMatchObject({
      state: "thinking",
      retryable: false,
      cancellable: true,
      attempt: 1,
    });
  } finally {
    server.stop();
  }
});

test("app transport send fails the turn instead of leaving thinking when queue handoff fails", async () => {
  const serviceClient: ButlerServiceClient = {
    enqueueAppTurn() {
      throw new Error("simulated queue write failure");
    },
  };
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
    serviceClient,
  });
  try {
    const result = await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "this must not get stuck thinking",
      client_message_id: "client-queue-failure",
    });

    expect(result.data.turn).toMatchObject({
      state: "failed",
      safe_status_label: "Failed",
      safe_error_code: "app_turn_queue_failed",
      retryable: true,
      cancellable: false,
    });
    const pendingDir = join(tempDir, "runtime", "inbound-events", "pending");
    expect(existsSync(pendingDir) ? readdirSync(pendingDir) : []).toEqual([]);

    const turns = await getJson(`${server.url}turns?chat_id=general&cursor=0`);
    expect(turns.data.turns[0]).toMatchObject({
      state: "failed",
      safe_error_code: "app_turn_queue_failed",
      retryable: true,
      cancellable: false,
    });

    const messages = await getJson(
      `${server.url}messages?chat_id=general&cursor=0`,
    );
    expect(messages.data.messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        status: "failed",
        safe_error_code: "app_turn_queue_failed",
        text: "Butler could not queue this request for execution. Retry the turn.",
      }),
    );

    const replay = await getJson(`${server.url}events?cursor=0`);
    expect(
      replay.data.events.some(
        (event: { type: string; payload?: { turn_id?: string } }) =>
          event.type === "turn.queued" &&
          event.payload?.turn_id === result.data.turn.id,
      ),
    ).toBe(false);
    expect(
      replay.data.events.some(
        (event: { type: string; payload?: { safe_error_code?: string } }) =>
          event.type === "turn.queue_failed" &&
          event.payload?.safe_error_code === "app_turn_queue_failed",
      ),
    ).toBe(true);
  } finally {
    server.stop();
  }
});

test("app transport send fails instead of leaving thinking when butler-main state is stale", async () => {
  const servicesDir = join(tempDir, "state", "services");
  mkdirSync(servicesDir, { recursive: true });
  writeFileSync(
    join(servicesDir, "butler-main.json"),
    JSON.stringify({
      version: 1,
      supervisor: "native-supervisor",
      serviceId: "butler-main",
      pid: 999_999_999,
      processGroupId: 999_999_999,
      mode: "detached",
      startedAt: "2099-01-01T00:00:00.000Z",
      command: "bash",
      args: ["start-butler.sh"],
      cwd: tempDir,
      stdoutFile: join(tempDir, "logs", "butler-out.log"),
      stderrFile: join(tempDir, "logs", "butler-err.log"),
      restartPolicy: "watchdog",
    }),
  );
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
  });
  try {
    const result = await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "do not leave this thinking",
      client_message_id: "client-stale-main",
    });

    expect(result.data.turn).toMatchObject({
      state: "failed",
      safe_error_code: "app_turn_queue_failed",
      retryable: true,
      cancellable: false,
    });
    const pendingDir = join(tempDir, "runtime", "inbound-events", "pending");
    expect(existsSync(pendingDir) ? readdirSync(pendingDir) : []).toEqual([]);

    const replay = await getJson(`${server.url}events?cursor=0`);
    expect(
      replay.data.events.some(
        (event: { type: string; payload?: { turn_id?: string } }) =>
          event.type === "turn.queued" &&
          event.payload?.turn_id === result.data.turn.id,
      ),
    ).toBe(false);
    expect(
      replay.data.events.some(
        (event: { type: string; payload?: { safe_error_code?: string } }) =>
          event.type === "turn.queue_failed" &&
          event.payload?.safe_error_code === "app_turn_queue_failed",
      ),
    ).toBe(true);
  } finally {
    server.stop();
  }
});

test("app transport send accepts live native main state when service supervisor state is stale", async () => {
  const servicesDir = join(tempDir, "state", "services");
  mkdirSync(servicesDir, { recursive: true });
  writeFileSync(
    join(servicesDir, "butler-main.json"),
    JSON.stringify({
      version: 1,
      supervisor: "native-supervisor",
      serviceId: "butler-main",
      pid: 999_999_999,
      processGroupId: 999_999_999,
      mode: "detached",
      startedAt: "2099-01-01T00:00:00.000Z",
      command: "bash",
      args: ["start-butler.sh"],
      cwd: tempDir,
      stdoutFile: join(tempDir, "logs", "butler-out.log"),
      stderrFile: join(tempDir, "logs", "butler-err.log"),
      restartPolicy: "watchdog",
    }),
  );
  writeFileSync(
    join(tempDir, "state", "butler-main-native.json"),
    JSON.stringify({
      pid: process.pid,
      startedAt: "2026-06-28T00:00:00.000Z",
      runtime: "codex-api",
      launcher: "start-butler.sh",
    }),
  );
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
  });
  try {
    const result = await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "queue this with live native main",
      client_message_id: "client-live-native-main",
    });

    expect(result.data.turn).toMatchObject({
      state: "thinking",
      retryable: false,
      cancellable: true,
    });
    expect(result.data.turn.safe_error_code).toBeUndefined();
    const pendingDir = join(tempDir, "runtime", "inbound-events", "pending");
    expect(existsSync(pendingDir) ? readdirSync(pendingDir) : []).toHaveLength(1);

    const replay = await getJson(`${server.url}events?cursor=0`);
    expect(
      replay.data.events.some(
        (event: { type: string; payload?: { turn_id?: string } }) =>
          event.type === "turn.queued" &&
          event.payload?.turn_id === result.data.turn.id,
      ),
    ).toBe(true);
    expect(
      replay.data.events.some(
        (event: { type: string; payload?: { safe_error_code?: string } }) =>
          event.type === "turn.queue_failed" &&
          event.payload?.safe_error_code === "app_turn_queue_failed",
      ),
    ).toBe(false);
  } finally {
    server.stop();
  }
});

test("app transport send binds current settings model without persisting implicit composer defaults", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
  });
  try {
    const settings = await patchJson(`${server.url}settings`, {
      model: "zai/glm-5.2",
      reasoning_effort: "medium",
    });
    expect(settings.data.model).toBe("zai/glm-5.2");

    const result = await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "use the current app settings model",
      client_message_id: "client-44444444-4444-4444-8444-444444444444",
    });
    expect(result.data.turn.state).toBe("thinking");

    const bindings = new SessionBindingStore(
      join(tempDir, "runtime", "session-store.sqlite"),
    );
    try {
      expect(
        bindings.getBySessionId("butler/app-general")?.modelRef,
      ).toBe("zai/glm-5.2");
    } finally {
      bindings.close();
    }

    const db = new Database(join(tempDir, "app.sqlite"));
    try {
      const storedControls = db
        .query<{ value_json: string }, []>(
          `
            SELECT value_json
            FROM app_settings
            WHERE key = 'session-controls:general'
          `,
        )
        .get();
      expect(storedControls).toBeNull();
    } finally {
      db.close();
    }
  } finally {
    server.stop();
  }
});

test("legacy session controls without explicit marker do not override app settings model", async () => {
  const dbPath = join(tempDir, "app.sqlite");
  const server = createAppServer({
    dbPath,
    butlerData: tempDir,
    port: 0,
  });
  try {
    await patchJson(`${server.url}settings`, {
      model: "zai/glm-5.2",
      reasoning_effort: "medium",
    });
    const db = new Database(dbPath);
    try {
      db.query(
        `
          INSERT INTO app_settings (key, value_json, updated_at)
          VALUES ('session-controls:general', ?, ?)
        `,
      ).run(
        JSON.stringify({
          model: "openai/gpt-5.5",
          reasoning_effort: "medium",
          access_mode: "full_access",
          plan_mode: false,
        }),
        new Date().toISOString(),
      );
    } finally {
      db.close();
    }

    const inherited = await getJson(`${server.url}sessions/general/controls`);
    expect(inherited.data.controls.model).toBe("zai/glm-5.2");

    await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "use settings despite legacy stale controls",
      client_message_id: "client-55555555-5555-4555-8555-555555555555",
    });
    const bindings = new SessionBindingStore(
      join(tempDir, "runtime", "session-store.sqlite"),
    );
    try {
      expect(bindings.getBySessionId("butler/app-general")?.modelRef).toBe(
        "zai/glm-5.2",
      );
    } finally {
      bindings.close();
    }

    const explicit = await patchJson(`${server.url}sessions/general/controls`, {
      model: "openai/gpt-5.5",
      reasoning_effort: "medium",
    });
    expect(explicit.data.controls.model).toBe("openai/gpt-5.5");
    const roundTrip = await getJson(`${server.url}sessions/general/controls`);
    expect(roundTrip.data.controls.model).toBe("openai/gpt-5.5");
  } finally {
    server.stop();
  }
});

test("active app transport turns keep follow-up messages in the editable session queue", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
  });
  try {
    const first = await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "start a long local turn",
      client_message_id: "client-22222222-2222-4222-8222-222222222222",
    });
    expect(first.data.turn.state).toBe("thinking");

    const followUp = await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "apply this after the current turn",
      queue_policy: "enqueue_if_busy",
      client_message_id: "client-33333333-3333-4333-8333-333333333333",
    });
    expect(followUp.data.accepted).toBeUndefined();
    expect(followUp.data.queued).toMatchObject({
      chat_id: "general",
      text: "apply this after the current turn",
      state: "queued",
    });

    const messages = await getJson(
      `${server.url}messages?chat_id=general&cursor=0`,
    );
    expect(
      messages.data.messages.map((message: { text: string }) => message.text),
    ).toEqual(["start a long local turn"]);

    const queue = await getJson(
      `${server.url}session-queue?session_id=general`,
    );
    expect(queue.data.queued_messages).toHaveLength(1);
    expect(queue.data.queued_messages[0].text).toBe(
      "apply this after the current turn",
    );

    const sessionView = await getJson(
      `${server.url}session-view?session_id=general`,
    );
    expect(JSON.stringify(sessionView)).not.toContain(
      "Queued for Butler Agent",
    );

    const queuedId = queue.data.queued_messages[0].id;
    const updated = await patchJson(
      `${server.url}session-queue/${encodeURIComponent(queuedId)}`,
      { text: "edited queued follow-up" },
    );
    expect(updated.data.queued_messages[0].text).toBe(
      "edited queued follow-up",
    );

    const deleted = await deleteJson(
      `${server.url}session-queue/${encodeURIComponent(queuedId)}`,
    );
    expect(deleted.data.queued_messages).toEqual([]);
  } finally {
    server.stop();
  }
});

test("app transport final result projection delivers queued turns after app-server restart", async () => {
  const dbPath = join(tempDir, "app.sqlite");
  let server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  const url = server.url;
  const session = await postJson(`${url}sessions`, {
    kind: "chat",
    title: "continue even if the app exits",
    session_hint: "queued-result-title",
  });
  const chatId = session.data.session.id;
  const runtimeSessionId = session.data.session.session_hint;
  const result = await postJson(`${url}messages`, {
    chat_id: chatId,
    text: "continue even if the app exits",
  });
  const turnId = result.data.turn.id;
  expect(result.data.turn.state).toBe("thinking");
  server.stop();

  writeFileSync(join(tempDir, "queued-result.md"), "# Queued result\n", "utf8");
  appendTranscriptEvent(
    createTranscriptEvent({
      sessionId: runtimeSessionId,
      kind: "outbound",
      transport: "app",
      timestamp: "2026-05-18T12:00:00.000Z",
      payload: {
        actionId: `queued-inbound-reply:test:app:${chatId}:main`,
        accountId: "local",
        peer: { kind: "dm", id: chatId },
        message: {
          text: "Core result projected from the durable app transport.",
          artifacts: [
            {
              id: "artifact-queued-result",
              kind: "document",
              title: "queued-result.md",
              safePathLabel: "queued-result.md",
              mimeType: "text/markdown",
            },
          ],
        },
        metadata: {
          kind: "final_result",
          turnId,
          source: "test",
          deliveryState: "delivered_with_limitations",
          limitationCodes: ["source_verified_missing"],
          limitations: [
            "Source verification remained unavailable.",
            "raw prompt text token=secret /Users/example/private",
          ],
          generatedSessionTitle: "Durable App 제목",
          loadedSkillNames: ["project-ledger"],
        },
      },
    }),
  );

  server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  try {
    const messages = await getJson(`${server.url}messages?chat_id=${chatId}`);
    expect(
      messages.data.messages.map((message: { text: string }) => message.text),
    ).toEqual([
      "continue even if the app exits",
      "Core result projected from the durable app transport.",
    ]);
    expect(server.store.getSession(chatId).title).toBe("Durable App 제목");
    const assistant = messages.data.messages.find(
      (message: { role: string }) => message.role === "assistant",
    );
    expect(assistant.attachments).toHaveLength(1);
    expect(assistant.attachments[0]).toMatchObject({
      kind: "text",
      mime_type: "text/markdown",
      safe_name: "queued-result.md",
    });
    expect(assistant.artifacts).toHaveLength(1);
    expect(assistant.artifacts[0]).toMatchObject({
      title: "queued-result.md",
      kind: "document",
      open_action: "route",
    });
    const turns = await getJson(`${server.url}turns?chat_id=${chatId}`);
    expect(turns.data.turns).toHaveLength(1);
    expect(turns.data.turns[0]).toMatchObject({
      id: turnId,
      state: "delivered",
      safe_status_label: "Delivered with limitations",
      cancellable: false,
      retryable: false,
    });
    const messagesAgain = await getJson(
      `${server.url}messages?chat_id=${chatId}`,
    );
    const assistantAgain = messagesAgain.data.messages.find(
      (message: { role: string }) => message.role === "assistant",
    );
    expect(assistantAgain.attachments).toHaveLength(1);
    expect(assistantAgain.artifacts).toHaveLength(1);
    const sessionView = await getJson(
      `${server.url}session-view?session_id=${chatId}`,
    );
    expect(sessionView.data.status).toBe("delivered");
    expect(sessionView.data.skills_used).toEqual(["project-ledger"]);
    expect(sessionView.data.active_turn).toBeNull();
    expect(sessionView.data.latest_turn).toMatchObject({
      id: turnId,
      state: "delivered",
      safe_status_label: "Delivered with limitations",
      delivery_state: "delivered_with_limitations",
      limitation_codes: ["source_verified_missing"],
      limitations: [
        "Source verification remained unavailable.",
        "A runtime limitation remained.",
      ],
      cancellable: false,
      retryable: false,
    });
    expect(
      sessionView.data.messages.map(
        (message: { text: string }) => message.text,
      ),
    ).toEqual([
      "continue even if the app exits",
      "Core result projected from the durable app transport.",
    ]);
    const sessionAssistant = sessionView.data.messages.find(
      (message: { role: string }) => message.role === "assistant",
    );
    expect(sessionAssistant).toMatchObject({
      status: "delivered",
      retryable: false,
      delivery_state: "delivered_with_limitations",
      limitation_codes: ["source_verified_missing"],
      limitations: [
        "Source verification remained unavailable.",
        "A runtime limitation remained.",
      ],
    });
    expect(JSON.stringify(sessionView)).not.toContain("token=secret");
    expect(JSON.stringify(sessionView)).not.toContain("/Users/example");
    expect(sessionAssistant.attachments).toHaveLength(1);
    expect(sessionView.data.artifacts).toContainEqual(
      expect.objectContaining({ title: "queued-result.md" }),
    );
  } finally {
    server.stop();
  }
});

test("app transport no-visible limited final closes queued turns without assistant text", async () => {
  const dbPath = join(tempDir, "app.sqlite");
  let server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  const result = await postJson(`${server.url}messages`, {
    chat_id: "general",
    text: "continue without generic recovery text",
  });
  const turnId = result.data.turn.id;
  server.stop();

  appendTranscriptEvent(
    createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: "2026-05-18T12:00:00.000Z",
      payload: {
        actionId: "queued-inbound-limited:test:app:general:no-visible",
        accountId: "local",
        peer: { kind: "dm", id: "general" },
        message: {
          text: "",
        },
        metadata: {
          kind: "final_result",
          turnId,
          source: "test",
          noVisibleReply: true,
          deliveryState: "delivered_with_limitations",
          limitationCodes: ["internal_recovery_required"],
          limitations: [
            "진행한 내용은 보존했습니다. 다음 요청에서 남은 작업을 이어갈 수 있습니다.",
          ],
        },
      },
    }),
  );

  server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  try {
    const messages = await getJson(`${server.url}messages?chat_id=general`);
    expect(
      messages.data.messages.map((message: { text: string }) => message.text),
    ).toEqual(["continue without generic recovery text"]);
    expect(JSON.stringify(messages)).not.toContain("진행한 내용은 보존했습니다");
    const turns = await getJson(`${server.url}turns?chat_id=general`);
    expect(turns.data.turns[0]).toMatchObject({
      id: turnId,
      state: "delivered",
      safe_status_label: "Delivered with limitations",
      retryable: false,
    });
    expect(turns.data.turns[0].safe_error_code ?? null).toBeNull();
    const summary = await getJson(`${server.url}session-summary?session_id=general`);
    expect(summary.data.latest_progress).toMatchObject({
      turn_id: turnId,
      state: "delivered",
      delivery_state: "delivered_with_limitations",
      limitation_codes: ["internal_recovery_required"],
      limitations: [],
    });
  } finally {
    server.stop();
  }
});

test("app transport internal recovery failures keep queued turns active without assistant text", async () => {
  const dbPath = join(tempDir, "app.sqlite");
  let server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  const result = await postJson(`${server.url}messages`, {
    chat_id: "general",
    text: "continue after internal recovery",
  });
  const turnId = result.data.turn.id;
  server.stop();

  appendTranscriptEvent(
    createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: "2026-05-18T12:00:00.000Z",
      payload: {
        actionId: "queued-inbound-failure:test:app:general:internal-recovery",
        accountId: "local",
        peer: { kind: "dm", id: "general" },
        message: {
          text: "Butler could not verify that the requested goal was completed.",
        },
        metadata: {
          kind: "turn_failed",
          turnId,
          source: "test",
          safeErrorCode: "internal_recovery_required",
          safeErrorCause:
            "Butler could not verify that the requested goal was completed.",
        },
      },
    }),
  );

  server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  try {
    const messages = await getJson(`${server.url}messages?chat_id=general`);
    expect(
      messages.data.messages.map((message: { text: string }) => message.text),
    ).toEqual(["continue after internal recovery"]);
    expect(JSON.stringify(messages)).not.toContain("could not verify");

    const turns = await getJson(`${server.url}turns?chat_id=general`);
    expect(turns.data.turns[0]).toMatchObject({
      id: turnId,
      state: "retrying",
      safe_status_label: "",
      retryable: false,
      cancellable: true,
      attempt: 2,
    });
    expect(turns.data.turns[0].safe_error_code ?? null).toBeNull();
    const sessions = await getJson(`${server.url}sessions`);
    expect(sessions.data.sessions[0]).toMatchObject({
      id: "general",
      active_turn_state: "retrying",
    });
    expect(sessions.data.sessions[0]).not.toHaveProperty("safe_status_label");

    const sessionView = await getJson(
      `${server.url}session-view?session_id=general`,
    );
    expect(sessionView.data.active_turn).toMatchObject({
      id: turnId,
      state: "retrying",
    });
    expect(sessionView.data.active_turn).not.toHaveProperty(
      "safe_status_label",
    );
    expect(sessionView.data.active_turn.progress.summary ?? "").toBe("");

    const events = await getJson(`${server.url}events?cursor=0`);
    const stateChanged = events.data.events.find(
      (event: {
        type: string;
        payload?: { turn?: { id?: string; state?: string } };
      }) =>
        event.type === "turn.state_changed" &&
        event.payload?.turn?.id === turnId &&
        event.payload?.turn?.state === "retrying",
    );
    expect(stateChanged).toBeTruthy();
    const stateChangedPayload = stateChanged?.payload;
    expect(stateChangedPayload).not.toHaveProperty("safe_status_label");
    expect(stateChangedPayload?.turn).not.toHaveProperty("safe_status_label");

    const summary = await getJson(`${server.url}session-summary?session_id=general`);
    expect(summary.data.latest_progress).toMatchObject({
      turn_id: turnId,
      state: "retrying",
    });
    expect(summary.data.latest_progress.summary ?? "").toBe("");
    expect(JSON.stringify(summary)).not.toContain("could not verify");
    expect(JSON.stringify(summary)).not.toContain("Continuing");
  } finally {
    server.stop();
  }
});

test("repeated app transport internal recovery does not requeue the same turn again", async () => {
  const dbPath = join(tempDir, "app.sqlite");
  let server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  const result = await postJson(`${server.url}messages`, {
    chat_id: "general",
    text: "continue after repeated internal recovery",
  });
  const turnId = result.data.turn.id;
  server.stop();

  appendTranscriptEvent(
    createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: "2026-05-18T12:00:00.000Z",
      payload: {
        actionId: "queued-inbound-failure:test:app:general:internal-recovery:first",
        accountId: "local",
        peer: { kind: "dm", id: "general" },
        message: {
          text: "Butler could not verify that the requested goal was completed.",
        },
        metadata: {
          kind: "turn_failed",
          turnId,
          source: "test",
          safeErrorCode: "internal_recovery_required",
        },
      },
    }),
  );

  server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  try {
    const firstTurns = await getJson(`${server.url}turns?chat_id=general`);
    expect(firstTurns.data.turns[0]).toMatchObject({
      id: turnId,
      state: "retrying",
      safe_status_label: "",
      retryable: false,
      cancellable: true,
      attempt: 2,
    });
    const firstEvents = await getJson(`${server.url}events?cursor=0`);
    const firstQueuedCount = firstEvents.data.events.filter(
      (event: { type: string; payload?: { turn_id?: string } }) =>
        event.type === "turn.queued" && event.payload?.turn_id === turnId,
    ).length;
    expect(firstQueuedCount).toBe(2);

    appendTranscriptEvent(
      createTranscriptEvent({
        sessionId: "butler/app-general",
        kind: "outbound",
        transport: "app",
        timestamp: "2099-01-01T00:00:00.000Z",
        payload: {
          actionId: "queued-inbound-failure:test:app:general:internal-recovery:second",
          accountId: "local",
          peer: { kind: "dm", id: "general" },
          message: {
            text: "Butler could not verify that the requested goal was completed.",
          },
          metadata: {
            kind: "turn_failed",
            turnId,
            source: "test",
            safeErrorCode: "internal_recovery_required",
          },
        },
      }),
    );

    const secondTurns = await getJson(`${server.url}turns?chat_id=general`);
    expect(secondTurns.data.turns[0]).toMatchObject({
      id: turnId,
      state: "failed",
      safe_status_label: "Retry required",
      safe_error_code: "internal_recovery_required",
      retryable: true,
      cancellable: false,
      attempt: 2,
    });
    const messages = await getJson(`${server.url}messages?chat_id=general`);
    const assistantMessages = messages.data.messages.filter(
      (message: { role: string }) => message.role === "assistant",
    );
    expect(assistantMessages).toHaveLength(0);
    expect(JSON.stringify(messages)).not.toContain("could not verify");
    expect(JSON.stringify(messages)).not.toContain("같은 이어가기 상태");

    const secondEvents = await getJson(`${server.url}events?cursor=0`);
    const secondQueuedCount = secondEvents.data.events.filter(
      (event: { type: string; payload?: { turn_id?: string } }) =>
        event.type === "turn.queued" && event.payload?.turn_id === turnId,
    ).length;
    expect(secondQueuedCount).toBe(firstQueuedCount);
    const secondSummary = await getJson(`${server.url}session-summary?session_id=general`);
    expect(secondSummary.data.latest_progress).toMatchObject({
      turn_id: turnId,
      state: "failed",
      summary: "Retry required",
    });
    expect(JSON.stringify(secondEvents)).not.toContain("Recovery needs continuation");
    expect(JSON.stringify(secondEvents)).not.toContain("같은 이어가기 상태");
    expect(
      secondEvents.data.events.some(
        (event: { type: string; payload?: { turn_id?: string } }) =>
          event.type === "agent.turn_event" &&
          event.payload?.turn_id === turnId,
      ),
    ).toBe(true);
  } finally {
    server.stop();
  }
});

test("app transport continuation after retry progress requeues without fallback final text", async () => {
  const dbPath = join(tempDir, "app.sqlite");
  let server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  const result = await postJson(`${server.url}messages`, {
    chat_id: "general",
    text: "continue after progressed internal recovery",
  });
  const turnId = result.data.turn.id;
  server.stop();

  appendTranscriptEvent(
    createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: "2026-05-18T12:00:00.000Z",
      payload: {
        actionId: "queued-inbound-failure:test:app:general:progressed:first",
        accountId: "local",
        peer: { kind: "dm", id: "general" },
        message: {
          text: "Butler could not verify that the requested goal was completed.",
        },
        metadata: {
          kind: "turn_failed",
          turnId,
          source: "test",
          safeErrorCode: "internal_recovery_required",
        },
      },
    }),
  );

  server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  try {
    const firstEvents = await getJson(`${server.url}events?cursor=0`);
    const firstQueuedEvents = firstEvents.data.events.filter(
      (event: { type: string; payload?: { turn_id?: string } }) =>
        event.type === "turn.queued" && event.payload?.turn_id === turnId,
    );
    const firstQueuedCount = firstQueuedEvents.length;
    const queueId = firstQueuedEvents.at(-1)?.payload?.queue_id;
    expect(typeof queueId).toBe("string");
    const dispatchClaimId = "claim-progressed-continuation";
    const processedQueueDir = join(tempDir, "runtime", "inbound-events", "processed");
    mkdirSync(processedQueueDir, { recursive: true });
    writeFileSync(
      join(processedQueueDir, `${queueId}.json`),
      JSON.stringify({
        queueId,
        processedAt: "2026-05-18T12:00:02.000Z",
        metadata: { terminalClaimId: dispatchClaimId },
      }),
    );

    appendTranscriptEvent(
      createTranscriptEvent({
        sessionId: "butler/app-general",
        kind: "outbound",
        transport: "app",
        timestamp: "2026-05-18T12:00:01.000Z",
        payload: {
          actionId: "runtime-intermediate:test:app:general:progressed:tool",
          accountId: "local",
          peer: { kind: "dm", id: "general" },
          message: { text: "" },
          metadata: {
            source: "runtime/native-tool-loop.ts",
            kind: "tool_progress",
            activityKind: "ran_command",
            toolCallId: "tool-progressed",
            toolName: "Bash",
            safeLabel: "Bash: test command",
            inputLabel: "test command",
            workBlockId: "work-validate",
            workBlockLabel: "검증 실행 중",
            decisionSummary: "테스트 실행 결과를 기준으로 다음 수정을 이어간다.",
            sessionId: "butler/app-general",
            turnId,
          },
        },
      }),
    );
    appendTranscriptEvent(
      createTranscriptEvent({
        sessionId: "butler/app-general",
        kind: "outbound",
        transport: "app",
        timestamp: "2026-05-18T12:00:02.000Z",
        payload: {
          actionId: `queued-inbound-limited:${queueId}:app:${turnId}`,
          accountId: "local",
          peer: { kind: "dm", id: "general" },
          message: { text: "" },
          metadata: {
            kind: "final_result",
            turnId,
            queueId,
            dispatchClaimId,
            source: "test",
            noVisibleReply: true,
            deliveryState: "recovering_internal",
            limitationCodes: ["internal_recovery_required"],
            limitations: [],
          },
        },
      }),
    );

    const turns = await getJson(`${server.url}turns?chat_id=general`);
    expect(turns.data.turns[0]).toMatchObject({
      id: turnId,
      state: "retrying",
      safe_status_label: "",
      retryable: false,
      cancellable: true,
      attempt: 3,
    });
    const messages = await getJson(`${server.url}messages?chat_id=general`);
    expect(
      messages.data.messages.filter((message: { role: string }) => message.role === "assistant"),
    ).toHaveLength(0);
    expect(JSON.stringify(messages)).not.toContain("같은 이어가기 상태");
    expect(JSON.stringify(messages)).not.toContain("could not verify");

    const secondEvents = await getJson(`${server.url}events?cursor=0`);
    const secondQueuedCount = secondEvents.data.events.filter(
      (event: { type: string; payload?: { turn_id?: string } }) =>
        event.type === "turn.queued" && event.payload?.turn_id === turnId,
    ).length;
    expect(secondQueuedCount).toBe(firstQueuedCount + 1);
    expect(JSON.stringify(secondEvents)).not.toContain("같은 이어가기 상태");
    expect(JSON.stringify(secondEvents)).not.toContain("Recovery needs continuation");
  } finally {
    server.stop();
  }
});

test("app transport internal recovery failures do not mask prior provider failures", async () => {
  const dbPath = join(tempDir, "app.sqlite");
  let server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  const result = await postJson(`${server.url}messages`, {
    chat_id: "general",
    text: "preserve provider failure",
  });
  const turnId = result.data.turn.id;
  server.stop();

  appendTranscriptEvent(
    createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: "2026-05-18T12:00:00.000Z",
      payload: {
        actionId: "queued-inbound-failure:test:app:general:provider-first",
        accountId: "local",
        peer: { kind: "dm", id: "general" },
        message: {
          text: "OpenAI API request failed with HTTP 500.",
        },
        metadata: {
          kind: "turn_failed",
          turnId,
          source: "test",
          safeErrorCode: "provider_api_error",
        },
      },
    }),
  );
  appendTranscriptEvent(
    createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: "2026-05-18T12:00:01.000Z",
      payload: {
        actionId: "queued-inbound-failure:test:app:general:late-internal",
        accountId: "local",
        peer: { kind: "dm", id: "general" },
        message: {
          text: "Butler could not verify that the requested goal was completed.",
        },
        metadata: {
          kind: "turn_failed",
          turnId,
          source: "test",
          safeErrorCode: "internal_recovery_required",
        },
      },
    }),
  );

  server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  try {
    const messages = await getJson(`${server.url}messages?chat_id=general`);
    expect(
      messages.data.messages.map((message: { text: string }) => message.text),
    ).toEqual([
      "preserve provider failure",
      "OpenAI API request failed with HTTP 500.",
    ]);

    const turns = await getJson(`${server.url}turns?chat_id=general`);
    expect(turns.data.turns[0]).toMatchObject({
      id: turnId,
      state: "failed",
      safe_error_code: "provider_api_error",
      retryable: true,
    });
    expect(JSON.stringify(messages)).not.toContain("could not verify");
  } finally {
    server.stop();
  }
});

test("app transport no-visible final removes an earlier failure assistant for the same turn", async () => {
  const dbPath = join(tempDir, "app.sqlite");
  let server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  const result = await postJson(`${server.url}messages`, {
    chat_id: "general",
    text: "continue after a recoverable dispatch failure",
  });
  const turnId = result.data.turn.id;
  server.stop();
  const queueId = "queue-no-visible-cleanup";
  const dispatchClaimId = "claim-no-visible-cleanup";
  const failedQueueDir = join(tempDir, "runtime", "inbound-events", "failed");
  mkdirSync(failedQueueDir, { recursive: true });
  writeFileSync(
    join(failedQueueDir, `${queueId}.json`),
    JSON.stringify({
      queueId,
      failedAt: "2026-05-18T12:00:00.000Z",
      metadata: {
        terminalClaimId: dispatchClaimId,
        failure: { code: "inbound_dispatch_timeout" },
      },
    }),
  );

  appendTranscriptEvent(
    createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: "2026-05-18T12:00:00.000Z",
      payload: {
        actionId: "queued-inbound-failure:test:app:general:no-visible-cleanup",
        accountId: "local",
        peer: { kind: "dm", id: "general" },
        message: {
          text: "Butler did not finish this queued request before the dispatch lease expired. Retry the turn.",
        },
        metadata: {
          kind: "turn_failed",
          turnId,
          queueId,
          dispatchClaimId,
          safeErrorCode: "inbound_dispatch_timeout",
          source: "test",
        },
      },
    }),
  );
  appendTranscriptEvent(
    createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: "2026-05-18T12:00:01.000Z",
      payload: {
        actionId: "queued-inbound-limited:test:app:general:no-visible-cleanup",
        accountId: "local",
        peer: { kind: "dm", id: "general" },
        message: {
          text: "",
        },
        metadata: {
          kind: "final_result",
          turnId,
          queueId,
          dispatchClaimId,
          source: "test",
          noVisibleReply: true,
          deliveryState: "delivered_with_limitations",
          limitationCodes: ["internal_recovery_required"],
          limitations: [
            "진행한 내용은 보존했습니다. 다음 요청에서 남은 작업을 이어갈 수 있습니다.",
          ],
        },
      },
    }),
  );

  server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  try {
    const messages = await getJson(`${server.url}messages?chat_id=general`);
    expect(
      messages.data.messages.map((message: { role: string; text: string }) => [
        message.role,
        message.text,
      ]),
    ).toEqual([
      ["user", "continue after a recoverable dispatch failure"],
    ]);
    expect(JSON.stringify(messages)).not.toContain("dispatch lease expired");
    expect(JSON.stringify(messages)).not.toContain("진행한 내용은 보존했습니다");
    const summary = await getJson(`${server.url}session-summary?session_id=general`);
    expect(summary.data.latest_progress).toMatchObject({
      turn_id: turnId,
      state: "delivered",
      delivery_state: "delivered_with_limitations",
      limitation_codes: ["internal_recovery_required"],
      limitations: [],
    });
  } finally {
    server.stop();
  }
});

test("app transport no-visible final with missing delivery metadata does not create fallback text", async () => {
  const dbPath = join(tempDir, "app.sqlite");
  let server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  const result = await postJson(`${server.url}messages`, {
    chat_id: "general",
    text: "close this without visible final text",
  });
  const turnId = result.data.turn.id;
  server.stop();

  appendTranscriptEvent(
    createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: "2026-05-18T12:00:00.000Z",
      payload: {
        actionId: "queued-inbound-limited:test:app:general:no-visible-no-delivery",
        accountId: "local",
        peer: { kind: "dm", id: "general" },
        message: {
          text: "",
        },
        metadata: {
          kind: "final_result",
          turnId,
          source: "test",
          noVisibleReply: true,
        },
      },
    }),
  );

  server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  try {
    const messages = await getJson(`${server.url}messages?chat_id=general`);
    expect(
      messages.data.messages.map((message: { text: string }) => message.text),
    ).toEqual(["close this without visible final text"]);
    expect(JSON.stringify(messages)).not.toContain("Butler did not return a visible reply");
    const summary = await getJson(`${server.url}session-summary?session_id=general`);
    expect(summary.data.latest_progress).toMatchObject({
      turn_id: turnId,
      state: "delivered",
      delivery_state: "delivered_with_limitations",
      limitation_codes: ["internal_recovery_required"],
      limitations: [],
    });
  } finally {
    server.stop();
  }
});

test("app transport no-visible final with system delivery state is not projected as a limitation", async () => {
  const dbPath = join(tempDir, "app.sqlite");
  let server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  const result = await postJson(`${server.url}messages`, {
    chat_id: "general",
    text: "keep active when a system blocker has no visible final",
  });
  const turnId = result.data.turn.id;
  server.stop();

  appendTranscriptEvent(
    createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: "2026-05-18T12:00:00.000Z",
      payload: {
        actionId: "queued-inbound-limited:test:app:general:no-visible-system-error",
        accountId: "local",
        peer: { kind: "dm", id: "general" },
        message: {
          text: "",
        },
        metadata: {
          kind: "final_result",
          turnId,
          source: "test",
          noVisibleReply: true,
          deliveryState: "system_error",
          limitationCodes: ["provider_failed"],
        },
      },
    }),
  );

  server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  try {
    const messages = await getJson(`${server.url}messages?chat_id=general`);
    expect(
      messages.data.messages.map((message: { text: string }) => message.text),
    ).toEqual(["keep active when a system blocker has no visible final"]);
    expect(JSON.stringify(messages)).not.toContain("Delivered with limitations");
    const turns = await getJson(`${server.url}turns?chat_id=general`);
    expect(turns.data.turns[0]).toMatchObject({
      id: turnId,
      state: "thinking",
      retryable: false,
      cancellable: true,
    });
    expect(turns.data.turns[0].safe_error_code ?? null).toBeNull();
  } finally {
    server.stop();
  }
});

test("app transport preserves marked public progress finalization text", async () => {
  const dbPath = join(tempDir, "app.sqlite");
  let server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  const result = await postJson(`${server.url}messages`, {
    chat_id: "general",
    text: "continue with a public progress summary",
  });
  const turnId = result.data.turn.id;
  server.stop();
  const progressText = [
    "진행한 내용은 보존했습니다. 다만 마지막 마무리 단계까지 완전히 닫지는 못했습니다.",
    "",
    "확인된 진행사항:",
    "- 파일을 작성했습니다.",
    "",
    "남은 부분: 최종 보고 정리가 남아 있습니다.",
    "다음 진행에서는 이 지점부터 이어가면 됩니다.",
  ].join("\n");

  appendTranscriptEvent(
    createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: "2026-05-18T12:00:00.000Z",
      payload: {
        actionId: "queued-inbound-limited:test:app:general:visible-progress-finalization",
        accountId: "local",
        peer: { kind: "dm", id: "general" },
        message: {
          text: progressText,
        },
        metadata: {
          kind: "final_result",
          turnId,
          source: "test",
          visibleLimitedReply: true,
          deliveryState: "delivered_with_limitations",
          limitationCodes: ["internal_recovery_required"],
          limitations: [progressText],
        },
      },
    }),
  );

  server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  try {
    const messages = await getJson(`${server.url}messages?chat_id=general`);
    expect(
      messages.data.messages.map((message: { text: string }) => message.text),
    ).toEqual(["continue with a public progress summary", progressText]);
    const assistant = messages.data.messages.find(
      (message: { role: string }) => message.role === "assistant",
    );
    expect(assistant).toMatchObject({
      delivery_state: "delivered_with_limitations",
      limitation_codes: ["internal_recovery_required"],
    });
    expect(assistant.limitations[0]).toContain("확인된 진행사항");
    expect(assistant.limitations[0]).toContain("파일을 작성했습니다.");
  } finally {
    server.stop();
  }
});

test("app transport navigation sync skips zero-byte final artifacts", async () => {
  const dbPath = join(tempDir, "app.sqlite");
  let server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  const url = server.url;
  const result = await postJson(`${url}messages`, {
    chat_id: "general",
    text: "project final answer with empty artifact",
  });
  const turnId = result.data.turn.id;
  server.stop();

  writeFileSync(join(tempDir, "result.md"), "# Projected result\n", "utf8");
  writeFileSync(join(tempDir, "empty.err"), "", "utf8");
  appendTranscriptEvent(
    createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: "2026-05-18T12:00:00.000Z",
      payload: {
        actionId: "queued-inbound-reply:test:app:general:empty-artifact",
        accountId: "local",
        peer: { kind: "dm", id: "general" },
        message: {
          text: "Final answer with one empty artifact.",
          artifacts: [
            {
              id: "artifact-result",
              kind: "document",
              title: "result.md",
              safePathLabel: "result.md",
              mimeType: "text/markdown",
            },
            {
              id: "artifact-empty",
              kind: "file",
              title: "empty.err",
              safePathLabel: "empty.err",
              mimeType: "application/octet-stream",
              sizeBytes: 0,
            },
          ],
        },
        metadata: {
          kind: "final_result",
          turnId,
          source: "test",
        },
      },
    }),
  );

  server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  try {
    const navigation = await getJson(`${server.url}navigation`);
    expect(navigation.data.chats.length).toBeGreaterThan(0);

    const messages = await getJson(`${server.url}messages?chat_id=general`);
    const assistant = messages.data.messages.find(
      (message: { role: string }) => message.role === "assistant",
    );
    expect(assistant.text).toBe("Final answer with one empty artifact.");
    expect(assistant.attachments).toHaveLength(1);
    expect(assistant.attachments[0]).toMatchObject({
      safe_name: "result.md",
      size_bytes: 19,
    });
    expect(assistant.artifacts).toHaveLength(1);

    const turns = await getJson(`${server.url}turns?chat_id=general`);
    expect(turns.data.turns[0]).toMatchObject({
      id: turnId,
      state: "delivered",
    });
  } finally {
    server.stop();
  }
});

test("app transport final result projection strips Butler final-answer envelope", async () => {
  const dbPath = join(tempDir, "app.sqlite");
  let server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  const url = server.url;
  const result = await postJson(`${url}messages`, {
    chat_id: "general",
    text: "project enveloped final answer",
  });
  const turnId = result.data.turn.id;
  server.stop();

  appendTranscriptEvent(
    createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: "2026-05-18T12:00:00.000Z",
      payload: {
        actionId: "queued-inbound-reply:test:app:general:enveloped-final",
        accountId: "local",
        peer: { kind: "dm", id: "general" },
        message: {
          text: [
            "<butler_final_answer>",
            "Visible final answer.",
            "</butler_final_answer>",
            "",
            "Sources:",
            "- official source",
          ].join("\n"),
        },
        metadata: {
          kind: "final_result",
          turnId,
          source: "test",
        },
      },
    }),
  );

  server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  try {
    const messages = await getJson(`${server.url}messages?chat_id=general`);
    const assistant = messages.data.messages.find(
      (message: { role: string }) => message.role === "assistant",
    );
    expect(assistant.text).toBe(
      "Visible final answer.\n\nSources:\n- official source",
    );
    expect(assistant.text).not.toContain("butler_final_answer");
  } finally {
    server.stop();
  }
});

test("app transport final result projection does not resurrect cancelled turns", async () => {
  const dbPath = join(tempDir, "app.sqlite");
  let server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  const url = server.url;
  const result = await postJson(`${url}messages`, {
    chat_id: "general",
    text: "cancel stale app result",
  });
  const turnId = result.data.turn.id;
  expect(result.data.turn.state).toBe("thinking");

  const cancel = await postJson(
    `${url}turns/${encodeURIComponent(turnId)}/cancel`,
    {},
  );
  expect(cancel.data.turn).toMatchObject({
    state: "cancelled",
    cancellable: false,
    retryable: false,
  });
  server.stop();

  appendTranscriptEvent(
    createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: "2026-05-18T12:00:00.000Z",
      payload: {
        actionId: "queued-inbound-reply:test:app:general:stale-after-cancel",
        accountId: "local",
        peer: { kind: "dm", id: "general" },
        message: {
          text: "This late result must not be delivered.",
        },
        metadata: {
          kind: "final_result",
          turnId,
          source: "test",
        },
      },
    }),
  );

  server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  try {
    const messages = await getJson(`${server.url}messages?chat_id=general`);
    expect(
      messages.data.messages.map((message: { text: string }) => message.text),
    ).toEqual(["cancel stale app result", "Stopped."]);

    const turns = await getJson(`${server.url}turns?chat_id=general`);
    expect(turns.data.turns).toHaveLength(1);
    expect(turns.data.turns[0]).toMatchObject({
      id: turnId,
      state: "cancelled",
      cancellable: false,
      retryable: false,
    });
  } finally {
    server.stop();
  }
});

test("app transport failure projection does not downgrade delivered turns", async () => {
  const dbPath = join(tempDir, "app.sqlite");
  let server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  const url = server.url;
  const result = await postJson(`${url}messages`, {
    chat_id: "general",
    text: "keep the completed turn stable",
  });
  const turnId = result.data.turn.id;
  expect(result.data.turn.state).toBe("thinking");
  server.stop();

  appendTranscriptEvent(
    createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: "2026-05-18T12:00:00.000Z",
      payload: {
        actionId: "queued-inbound-reply:test:app:general:stable-final",
        accountId: "local",
        peer: { kind: "dm", id: "general" },
        message: {
          text: "The durable app result completed successfully.",
        },
        metadata: {
          kind: "final_result",
          turnId,
          source: "test",
        },
      },
    }),
  );
  appendTranscriptEvent(
    createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: "2026-05-18T12:00:01.000Z",
      payload: {
        actionId: "queued-inbound-failure:test:app:general:stale-after-final",
        accountId: "local",
        peer: { kind: "dm", id: "general" },
        message: {
          text: "Butler could not complete this turn.",
        },
        metadata: {
          kind: "turn_failed",
          turnId,
          safeErrorCode: "gateway_failed",
          source: "test",
        },
      },
    }),
  );

  server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  try {
    const messages = await getJson(`${server.url}messages?chat_id=general`);
    expect(
      messages.data.messages.map((message: { text: string }) => message.text),
    ).toEqual([
      "keep the completed turn stable",
      "The durable app result completed successfully.",
    ]);
    const assistant = messages.data.messages.find(
      (message: { role: string }) => message.role === "assistant",
    );
    expect(assistant.status).toBe("delivered");
    expect(assistant.safe_error_code ?? null).toBeNull();
    expect(assistant.retryable).toBe(false);

    const turns = await getJson(`${server.url}turns?chat_id=general`);
    expect(turns.data.turns).toHaveLength(1);
    expect(turns.data.turns[0]).toMatchObject({
      id: turnId,
      state: "delivered",
      cancellable: false,
      retryable: false,
    });
    expect(turns.data.turns[0].safe_error_code ?? null).toBeNull();
  } finally {
    server.stop();
  }
});

test("app transport final projection does not resurrect timed out failed turns", async () => {
  const dbPath = join(tempDir, "app.sqlite");
  let server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  const url = server.url;
  const result = await postJson(`${url}messages`, {
    chat_id: "general",
    text: "this turn times out before a late final",
  });
  const turnId = result.data.turn.id;
  expect(result.data.turn.state).toBe("thinking");
  server.stop();

  const failedQueueDir = join(tempDir, "runtime", "inbound-events", "failed");
  mkdirSync(failedQueueDir, { recursive: true });
  writeFileSync(
    join(failedQueueDir, "queue-timeout.json"),
    JSON.stringify({
      queueId: "queue-timeout",
      failedAt: "2026-05-18T12:00:00.000Z",
      metadata: {
        terminalClaimId: "claim-timeout",
        failure: { code: "inbound_dispatch_timeout" },
      },
    }),
  );
  appendTranscriptEvent(
    createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: "2026-05-18T12:00:00.000Z",
      payload: {
        actionId: "runtime-final:late-after-timeout",
        accountId: "local",
        peer: { kind: "dm", id: "general" },
        message: {
          text: "Late final must not resurrect the timed out turn.",
        },
        metadata: {
          kind: "final_result",
          turnId,
          queueId: "queue-timeout",
          dispatchClaimId: "claim-late-stale",
          source: "test",
        },
      },
    }),
  );
  appendTranscriptEvent(
    createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: "2026-05-18T12:00:01.000Z",
      payload: {
        actionId: "queued-inbound-failure:test:app:general:timeout-first",
        accountId: "local",
        peer: { kind: "dm", id: "general" },
        message: {
          text: "Butler did not finish this queued request before the dispatch lease expired. Retry the turn.",
        },
        metadata: {
          kind: "turn_failed",
          turnId,
          safeErrorCode: "inbound_dispatch_timeout",
          queueId: "queue-timeout",
          dispatchClaimId: "claim-timeout",
          source: "test",
        },
      },
    }),
  );

  server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  try {
    const messages = await getJson(`${server.url}messages?chat_id=general`);
    expect(
      messages.data.messages.map((message: { text: string }) => message.text),
    ).toEqual([
      "this turn times out before a late final",
      "Butler did not finish this queued request before the dispatch lease expired. Retry the turn.",
    ]);
    const turns = await getJson(`${server.url}turns?chat_id=general`);
    expect(turns.data.turns[0]).toMatchObject({
      id: turnId,
      state: "failed",
      safe_error_code: "inbound_dispatch_timeout",
      retryable: true,
      cancellable: false,
    });
  } finally {
    server.stop();
  }
});

test("recoverable limited final can close a timeout failed app turn", async () => {
  const dbPath = join(tempDir, "app.sqlite");
  let server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  const result = await postJson(`${server.url}messages`, {
    chat_id: "general",
    text: "continue a recoverable WorkStream",
  });
  const turnId = result.data.turn.id;
  server.stop();
  const queueId = "queue-recoverable-timeout";
  const dispatchClaimId = "claim-recoverable-timeout";
  const failedQueueDir = join(tempDir, "runtime", "inbound-events", "failed");
  mkdirSync(failedQueueDir, { recursive: true });
  writeFileSync(
    join(failedQueueDir, `${queueId}.json`),
    JSON.stringify({
      queueId,
      failedAt: "2026-05-18T12:00:00.000Z",
      metadata: {
        terminalClaimId: dispatchClaimId,
        failure: { code: "inbound_dispatch_timeout" },
      },
    }),
  );
  const db = new Database(dbPath);
  db.query(
    "INSERT INTO events (type, payload_json, created_at) VALUES (?, ?, ?)",
  ).run(
    "agent.turn_event",
    JSON.stringify({
      session_id: "general",
      turn_id: turnId,
      event: {
        id: "event-stale-prompt-budget-delivery",
        kind: "turn.completed",
        payload: {
          safeLabel: "Completed with limitations",
          delivery_state: "delivered_with_limitations",
          limitation_codes: ["prompt_usage_model_call_budget_exhausted"],
          limitations: [
            "Butler reached its internal model-call budget while trying to continue the turn.",
          ],
        },
      },
    }),
    "2026-05-18T11:59:59.000Z",
  );
  db.close();

  appendTranscriptEvent(
    createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: "2026-05-18T12:00:00.000Z",
      payload: {
        actionId: "queued-inbound-failure:test:app:general:recoverable-timeout",
        accountId: "local",
        peer: { kind: "dm", id: "general" },
        message: {
          text: "Butler did not finish this queued request before the dispatch lease expired. Retry the turn.",
        },
        metadata: {
          kind: "turn_failed",
          turnId,
          queueId,
          dispatchClaimId,
          safeErrorCode: "inbound_dispatch_timeout",
          source: "test",
        },
      },
    }),
  );
  appendTranscriptEvent(
    createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: "2026-05-18T12:00:01.000Z",
      payload: {
        actionId: "queued-inbound-limited:test:app:general:recoverable-final",
        accountId: "local",
        peer: { kind: "dm", id: "general" },
        message: {
          text: "진행한 내용은 보존했습니다. 다음 요청에서 남은 작업을 이어갈 수 있습니다.",
        },
        metadata: {
          kind: "final_result",
          turnId,
          queueId,
          dispatchClaimId,
          source: "test",
          deliveryState: "delivered_with_limitations",
          limitationCodes: ["internal_recovery_required"],
          limitations: [
            "진행한 내용은 보존했습니다. 다음 요청에서 남은 작업을 이어갈 수 있습니다.",
          ],
        },
      },
    }),
  );

  server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  try {
    const messages = await getJson(`${server.url}messages?chat_id=general`);
    expect(
      messages.data.messages.map((message: { text: string }) => message.text),
    ).toEqual([
      "continue a recoverable WorkStream",
    ]);
    expect(
      messages.data.messages.filter(
        (message: { role: string }) => message.role === "assistant",
      ),
    ).toEqual([]);
    expect(JSON.stringify(messages)).not.toContain("진행한 내용은 보존했습니다");
    const turns = await getJson(`${server.url}turns?chat_id=general`);
    expect(turns.data.turns[0]).toMatchObject({
      id: turnId,
      state: "delivered",
      retryable: false,
    });
    expect(turns.data.turns[0].safe_error_code ?? null).toBeNull();
    const summary = await getJson(`${server.url}session-summary?session_id=general`);
    expect(summary.data.latest_progress).toMatchObject({
      state: "delivered",
      delivery_state: "delivered_with_limitations",
      limitation_codes: ["internal_recovery_required"],
      limitations: [],
    });
    expect(
      summary.data.latest_progress.safe_progress_rows.some(
        (row: { kind: string; state: string }) =>
          row.kind === "turn" && row.state === "failed",
      ),
    ).toBe(false);
  } finally {
    server.stop();
  }
});

test("recoverable limited final without queue claim cannot close a failed app turn", async () => {
  const dbPath = join(tempDir, "app.sqlite");
  let server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  const result = await postJson(`${server.url}messages`, {
    chat_id: "general",
    text: "continue a failed turn without claim",
  });
  const turnId = result.data.turn.id;
  server.stop();

  appendTranscriptEvent(
    createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: "2026-05-18T12:00:00.000Z",
      payload: {
        actionId: "queued-inbound-failure:test:app:general:no-claim",
        accountId: "local",
        peer: { kind: "dm", id: "general" },
        message: {
          text: "Butler did not finish this queued request before the dispatch lease expired. Retry the turn.",
        },
        metadata: {
          kind: "turn_failed",
          turnId,
          safeErrorCode: "inbound_dispatch_timeout",
          source: "test",
        },
      },
    }),
  );
  appendTranscriptEvent(
    createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: "2026-05-18T12:00:01.000Z",
      payload: {
        actionId: "queued-inbound-limited:test:app:general:no-claim-final",
        accountId: "local",
        peer: { kind: "dm", id: "general" },
        message: {
          text: "진행한 내용은 보존했습니다. 다음 요청에서 남은 작업을 이어갈 수 있습니다.",
        },
        metadata: {
          kind: "final_result",
          turnId,
          source: "test",
          deliveryState: "delivered_with_limitations",
          limitationCodes: ["internal_recovery_required"],
          limitations: [
            "진행한 내용은 보존했습니다. 다음 요청에서 남은 작업을 이어갈 수 있습니다.",
          ],
        },
      },
    }),
  );

  server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  try {
    const messages = await getJson(`${server.url}messages?chat_id=general`);
    expect(
      messages.data.messages.map((message: { text: string }) => message.text),
    ).toEqual([
      "continue a failed turn without claim",
      "Butler did not finish this queued request before the dispatch lease expired. Retry the turn.",
    ]);
    const turns = await getJson(`${server.url}turns?chat_id=general`);
    expect(turns.data.turns[0]).toMatchObject({
      id: turnId,
      state: "failed",
      safe_error_code: "inbound_dispatch_timeout",
      retryable: true,
    });
  } finally {
    server.stop();
  }
});

test("app transport queued final waits for matching processed terminal record", async () => {
  const dbPath = join(tempDir, "app.sqlite");
  let server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  const url = server.url;
  const result = await postJson(`${url}messages`, {
    chat_id: "general",
    text: "this queued final must wait for queue completion",
  });
  const turnId = result.data.turn.id;
  server.stop();

  appendTranscriptEvent(
    createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: "2026-05-18T12:00:00.000Z",
      payload: {
        actionId: "runtime-final:wait-for-processed-terminal",
        accountId: "local",
        peer: { kind: "dm", id: "general" },
        message: {
          text: "Final after processed terminal.",
        },
        metadata: {
          kind: "final_result",
          turnId,
          queueId: "queue-wait-terminal",
          dispatchClaimId: "claim-wait-terminal",
          source: "test",
        },
      },
    }),
  );

  server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  try {
    const messages = await getJson(`${server.url}messages?chat_id=general`);
    expect(
      messages.data.messages.map((message: { text: string }) => message.text),
    ).toEqual([
      "this queued final must wait for queue completion",
    ]);
    const turns = await getJson(`${server.url}turns?chat_id=general`);
    expect(turns.data.turns[0]).toMatchObject({
      id: turnId,
      state: "thinking",
      retryable: false,
      cancellable: true,
    });
  } finally {
    server.stop();
  }

  const processedQueueDir = join(tempDir, "runtime", "inbound-events", "processed");
  mkdirSync(processedQueueDir, { recursive: true });
  writeFileSync(
    join(processedQueueDir, "queue-wait-terminal.json"),
    JSON.stringify({
      queueId: "queue-wait-terminal",
      processedAt: "2026-05-18T12:00:01.000Z",
      metadata: {
        terminalClaimId: "claim-wait-terminal",
        dispatchStatus: "handled",
      },
    }),
  );

  server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  try {
    const messages = await getJson(`${server.url}messages?chat_id=general`);
    expect(
      messages.data.messages.map((message: { text: string }) => message.text),
    ).toEqual([
      "this queued final must wait for queue completion",
      "Final after processed terminal.",
    ]);
    const turns = await getJson(`${server.url}turns?chat_id=general`);
    expect(turns.data.turns[0]).toMatchObject({
      id: turnId,
      state: "delivered",
      retryable: false,
      cancellable: false,
    });
  } finally {
    server.stop();
  }
});

test("app transport worker result projection is durable and idempotent", async () => {
  const dbPath = join(tempDir, "app.sqlite");
  appendTranscriptEvent(
    createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: "2026-05-19T12:00:00.000Z",
      payload: {
        actionId: "task-notification:worker-result-app-durable",
        accountId: "local",
        peer: { kind: "dm", id: "general" },
        message: {
          text: "Reviewed worker result for the app session.",
        },
        metadata: {
          kind: "worker_result",
          type: "worker-result",
          originSessionId: "butler/app-general",
        },
      },
    }),
  );

  const server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  try {
    const first = await getJson(`${server.url}messages?chat_id=general`);
    const second = await getJson(`${server.url}messages?chat_id=general`);
    const workerMessages = second.data.messages.filter(
      (message: { role: string; text: string }) =>
        message.role === "assistant" &&
        message.text === "Reviewed worker result for the app session.",
    );
    expect(
      first.data.messages.map((message: { text: string }) => message.text),
    ).toContain("Reviewed worker result for the app session.");
    expect(workerMessages).toHaveLength(1);
  } finally {
    server.stop();
  }
});

test("app transport progress projection recovers queued work blocks after app-server restart", async () => {
  const dbPath = join(tempDir, "app.sqlite");
  let server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  const result = await postJson(`${server.url}messages`, {
    chat_id: "general",
    text: "show queued progress",
  });
  const turnId = result.data.turn.id;
  const userMessageId = result.data.accepted.id;
  expect(result.data.turn.state).toBe("thinking");
  const beforeSessions = await getJson(`${server.url}sessions`);
  const beforeSession = beforeSessions.data.sessions.find(
    (session: { id: string }) => session.id === "general",
  );
  expect(beforeSession).toBeTruthy();
  server.stop();

  appendTranscriptEvent(
    createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: "2026-05-18T12:00:30.000Z",
      payload: {
        actionId: `runtime-intermediate:app:${userMessageId}:todo-running`,
        accountId: "local",
        peer: { kind: "dm", id: "general" },
        message: {
          text: "",
          replyToMessageId: userMessageId,
        },
        metadata: {
          kind: "todo_progress",
          todoId: "collect-news",
          safeLabel: "뉴스 근거 수집",
          state: "running",
          phase: "execution",
        },
      },
    }),
  );
  appendTranscriptEvent(
    createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: "2026-05-18T12:00:31.000Z",
      payload: {
        actionId: `runtime-intermediate:app:${userMessageId}:todo-delivered`,
        accountId: "local",
        peer: { kind: "dm", id: "general" },
        message: {
          text: "",
          replyToMessageId: userMessageId,
        },
        metadata: {
          kind: "todo_progress",
          todoId: "collect-news",
          safeLabel: "뉴스 근거 수집",
          state: "delivered",
          phase: "execution",
        },
      },
    }),
  );
  appendTranscriptEvent(
    createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: "2026-05-18T12:00:32.000Z",
      payload: {
        actionId: `runtime-intermediate:app:${userMessageId}:web-search-progress`,
        accountId: "local",
        peer: { kind: "dm", id: "general" },
        message: {
          text: "",
          replyToMessageId: userMessageId,
        },
        metadata: {
          kind: "tool_progress",
          activityKind: "searched",
          toolName: "Web search",
          safeLabel: "Web search: 충주 뉴스",
          inputLabel: "충주 뉴스",
          toolCallId: "tool-progress-1",
          workBlockId: "work-progress-1",
          workBlockLabel: "오늘 브리핑 근거를 찾는 중입니다.",
          detailRows: [
            {
              id: "queued-progress-query",
              kind: "query",
              safe_label: "Query",
              safe_value: "충주 뉴스",
              state: "running",
            },
          ],
        },
      },
    }),
  );

  server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  try {
    const messages = await getJson(`${server.url}messages?chat_id=general`);
    const afterSessions = await getJson(`${server.url}sessions`);
    const afterSession = afterSessions.data.sessions.find(
      (session: { id: string }) => session.id === "general",
    );
    expect(afterSession.updated_at).not.toBe(beforeSession.updated_at);
    expect(afterSession.last_activity_at).toBe(afterSession.updated_at);
    expect(afterSession.active_turn_state).toBe("thinking");
    expect(afterSession.safe_status_label).toBe("Web search: 충주 뉴스");
    expect(
      messages.data.turn_progress[turnId].safe_progress_rows,
    ).toContainEqual(
      expect.objectContaining({
        kind: "todo",
        safe_label: "뉴스 근거 수집",
        state: "delivered",
        safe_input_label: "collect-news",
      }),
    );
    expect(
      messages.data.turn_progress[turnId].safe_progress_rows,
    ).toContainEqual(
      expect.objectContaining({
        kind: "searched",
        safe_tool_name: "Web search",
        safe_input_label: "충주 뉴스",
        tool_call_id: "tool-progress-1",
        work_block_id: "work-progress-1",
        work_block_label: "오늘 브리핑 근거를 찾는 중입니다.",
      }),
    );
    const summary = await getJson(
      `${server.url}session-summary?session_id=general`,
    );
    expect(summary.data.latest_progress.safe_progress_rows).toContainEqual(
      expect.objectContaining({
        kind: "searched",
        safe_tool_name: "Web search",
        safe_input_label: "충주 뉴스",
      }),
    );
    const sessionView = await getJson(
      `${server.url}session-view?session_id=general`,
    );
    expect(
      sessionView.data.latest_turn.progress.safe_progress_rows,
    ).toContainEqual(
      expect.objectContaining({
        kind: "searched",
        safe_tool_name: "Web search",
        safe_input_label: "충주 뉴스",
        work_block_label: "오늘 브리핑 근거를 찾는 중입니다.",
      }),
    );
  } finally {
    server.stop();
  }
});

test("app transport progress projection ignores tool-start intermediate decisions", async () => {
  const dbPath = join(tempDir, "app.sqlite");
  let server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  const result = await postJson(`${server.url}messages`, {
    chat_id: "general",
    text: "show queued tool progress",
  });
  const turnId = result.data.turn.id;
  const userMessageId = result.data.accepted.id;
  server.stop();

  appendTranscriptEvent(
    createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: "2026-05-18T12:00:30.000Z",
      payload: {
        actionId: `runtime-intermediate:app:${userMessageId}:grep_files-start`,
        accountId: "local",
        peer: { kind: "dm", id: "general" },
        message: {
          text: "전체 테스트 exit code가 실패로 확인됐으니, 저장된 요약 파일에서 실패 라인만 검색 도구로 직접 추출하겠다냐. 실패 테스트명을 확인한 뒤 해당 테스트만 단독 실행해 수정하겠다냐.",
          replyToMessageId: userMessageId,
        },
        metadata: {
          kind: "intermediate",
          tool: "grep_files",
          phase: "before_tool_execution",
          turnId,
        },
      },
    }),
  );
  appendTranscriptEvent(
    createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: "2026-05-18T12:00:30.050Z",
      payload: {
        actionId: `runtime-intermediate:app:${userMessageId}:grep_files-progress`,
        accountId: "local",
        peer: { kind: "dm", id: "general" },
        message: {
          text: "",
          replyToMessageId: userMessageId,
        },
        metadata: {
          kind: "tool_progress",
          activityKind: "searched",
          toolName: "Search",
          safeLabel: "Search: not ok|AssertionError",
          inputLabel: "not ok|AssertionError",
          toolCallId: "tool-grep-files",
          workBlockId: "work-validate",
          workBlockLabel: "실패 테스트명을 확인하는 중",
          decisionSummary:
            "전체 테스트 exit code가 실패로 확인됐으니, 저장된 요약 파일에서 실패 라인만 검색 도구로 직접 추출하겠다냐.",
          decisionSource: "assistant-authored",
        },
      },
    }),
  );

  server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  try {
    const messages = await getJson(`${server.url}messages?chat_id=general`);
    const rows = messages.data.turn_progress[turnId].safe_progress_rows;
    expect(rows).not.toContainEqual(
      expect.objectContaining({
        id: `runtime-intermediate:app:${userMessageId}:grep_files-start`,
      }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({
        id: `runtime-intermediate:app:${userMessageId}:grep_files-progress`,
        kind: "searched",
        safe_label: "Search: not ok|AssertionError",
        safe_tool_name: "Search",
        safe_input_label: "not ok|AssertionError",
        work_block_label: "실패 테스트명을 확인하는 중",
        work_decision_summary:
          "전체 테스트 exit code가 실패로 확인됐으니, 저장된 요약 파일에서 실패 라인만 검색 도구로 직접 추출하겠다냐.",
      }),
    );
  } finally {
    server.stop();
  }
});

test("app transport progress projection stays idempotent after a large event backlog", async () => {
  const dbPath = join(tempDir, "app.sqlite");
  let server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  const result = await postJson(`${server.url}messages`, {
    chat_id: "general",
    text: "show one durable progress row",
  });
  const turnId = result.data.turn.id;
  const userMessageId = result.data.accepted.id;
  server.stop();

  appendTranscriptEvent(
    createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: "2026-05-18T12:04:00.000Z",
      payload: {
        actionId: `runtime-intermediate:app:${userMessageId}:single-progress`,
        accountId: "local",
        peer: { kind: "dm", id: "general" },
        message: {
          text: "",
          replyToMessageId: userMessageId,
        },
        metadata: {
          kind: "tool_progress",
          activityKind: "searched",
          toolName: "Web search",
          safeLabel: "Web search: durable row",
          inputLabel: "durable row",
          toolCallId: "tool-durable-progress",
        },
      },
    }),
  );

  server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  try {
    await getJson(`${server.url}messages?chat_id=general`);
    for (let index = 0; index < 1_100; index += 1) {
      server.store.appendSafeServerEvent("test.backlog", { index });
    }

    server.store.syncAllAppTransportEvents();
    const replay = await getJson(`${server.url}events?cursor=0`);
    const progressEvents = replay.data.events.filter(
      (event: {
        type: string;
        payload?: { turn_id?: string; row?: { id?: string } };
      }) =>
        event.type === "progress.summary" &&
        event.payload?.turn_id === turnId &&
        event.payload?.row?.id ===
          `runtime-intermediate:app:${userMessageId}:single-progress`,
    );
    expect(progressEvents).toHaveLength(1);
  } finally {
    server.stop();
  }
});

test("app transport sync skips unchanged transcript snapshots", async () => {
  const dbPath = join(tempDir, "app.sqlite");
  let server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  const result = await postJson(`${server.url}messages`, {
    chat_id: "general",
    text: "project one progress row once",
  });
  const turnId = result.data.turn.id;
  const userMessageId = result.data.accepted.id;
  server.stop();

  appendTranscriptEvent(
    createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: "2026-05-18T12:05:00.000Z",
      payload: {
        actionId: `runtime-intermediate:app:${userMessageId}:snapshot-progress`,
        accountId: "local",
        peer: { kind: "dm", id: "general" },
        message: {
          text: "",
          replyToMessageId: userMessageId,
        },
        metadata: {
          kind: "tool_progress",
          activityKind: "searched",
          toolName: "Web search",
          safeLabel: "Web search: snapshot row",
          inputLabel: "snapshot row",
          toolCallId: "tool-snapshot-progress",
        },
      },
    }),
  );

  server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  try {
    expect(server.store.syncAllAppTransportEvents()).toBe(1);
    expect(server.store.syncAllAppTransportEvents()).toBe(0);
    const row = server.store.db
      .query<{ count: number }, [string]>(
        `
      SELECT COUNT(*) AS count
      FROM events
      WHERE type = 'progress.summary'
        AND json_extract(payload_json, '$.turn_id') = ?
    `,
      )
      .get(turnId);
    expect(row?.count).toBe(1);
  } finally {
    server.stop();
  }
});

test("app transport sync includes archived sessions while a turn is active", async () => {
  const dbPath = join(tempDir, "app.sqlite");
  let server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  const result = await postJson(`${server.url}messages`, {
    chat_id: "general",
    text: "archived active progress",
  });
  const turnId = result.data.turn.id;
  const userMessageId = result.data.accepted.id;
  await postJson(`${server.url}sessions/general/archive`, {});
  server.stop();

  appendTranscriptEvent(
    createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: "2026-05-18T12:05:30.000Z",
      payload: {
        actionId: `runtime-intermediate:app:${userMessageId}:archived-active-progress`,
        accountId: "local",
        peer: { kind: "dm", id: "general" },
        message: {
          text: "",
          replyToMessageId: userMessageId,
        },
        metadata: {
          kind: "tool_progress",
          activityKind: "model",
          toolName: "모델 준비",
          safeLabel: "요청 확인: archived active progress",
          inputLabel: "",
        },
      },
    }),
  );

  server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  try {
    expect(server.store.syncAllAppTransportEvents()).toBe(1);
    const progress = server.store.listTurnProgressSnapshotsForMessages([
      result.data.accepted,
    ]);
    expect(progress[turnId]?.safe_progress_rows).toContainEqual(
      expect.objectContaining({
        kind: "model",
        safe_label: "요청 확인: archived active progress",
      }),
    );
  } finally {
    server.stop();
  }
});

test("app transport sync projects appended progress and final events once", async () => {
  const dbPath = join(tempDir, "app.sqlite");
  let server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  const result = await postJson(`${server.url}messages`, {
    chat_id: "general",
    text: "project appended progress and final",
  });
  const turnId = result.data.turn.id;
  const userMessageId = result.data.accepted.id;
  server.stop();

  appendTranscriptEvent(
    createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: "2026-05-18T12:06:00.000Z",
      payload: {
        actionId: `runtime-intermediate:app:${userMessageId}:initial-progress`,
        accountId: "local",
        peer: { kind: "dm", id: "general" },
        message: {
          text: "",
          replyToMessageId: userMessageId,
        },
        metadata: {
          kind: "tool_progress",
          activityKind: "searched",
          toolName: "Web search",
          safeLabel: "Web search: initial row",
          inputLabel: "initial row",
          toolCallId: "tool-initial-progress",
        },
      },
    }),
  );

  server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  try {
    expect(server.store.syncAllAppTransportEvents()).toBe(1);

    appendTranscriptEvent(
      createTranscriptEvent({
        sessionId: "butler/app-general",
        kind: "outbound",
        transport: "app",
        timestamp: "2026-05-18T12:06:01.000Z",
        payload: {
          actionId: `runtime-intermediate:app:${userMessageId}:appended-progress`,
          accountId: "local",
          peer: { kind: "dm", id: "general" },
          message: {
            text: "",
            replyToMessageId: userMessageId,
          },
          metadata: {
            kind: "tool_progress",
            activityKind: "read_file",
            toolName: "Read",
            safeLabel: "Read: appended row",
            inputLabel: "appended row",
            toolCallId: "tool-appended-progress",
          },
        },
      }),
    );
    appendTranscriptEvent(
      createTranscriptEvent({
        sessionId: "butler/app-general",
        kind: "outbound",
        transport: "app",
        timestamp: "2026-05-18T12:06:02.000Z",
        payload: {
          actionId: `runtime-final:app:${userMessageId}:appended-final`,
          accountId: "local",
          peer: { kind: "dm", id: "general" },
          message: {
            text: "Finished from appended final.",
            replyToMessageId: userMessageId,
          },
          metadata: {
            kind: "final_result",
            turnId,
            source: "test",
          },
        },
      }),
    );

    expect(server.store.syncAllAppTransportEvents()).toBe(2);
    expect(server.store.syncAllAppTransportEvents()).toBe(0);
    const summary = await getJson(
      `${server.url}session-summary?session_id=general`,
    );
    expect(summary.data.turn_state).toBe("delivered");
    expect(summary.data.latest_progress.state).toBe("delivered");
    expect(summary.data.latest_progress.safe_progress_rows).toContainEqual(
      expect.objectContaining({
        kind: "read_file",
        safe_tool_name: "Read",
        safe_input_label: "appended row",
      }),
    );
    const projected = server.store.db
      .query<{ count: number }, [string]>(
        `
      SELECT COUNT(*) AS count
      FROM projected_transport_events
      WHERE action_id = ?
    `,
      )
      .get(`runtime-final:app:${userMessageId}:appended-final`);
    expect(projected?.count).toBe(1);
  } finally {
    server.stop();
  }
});

test("terminal app transport snapshots do not expose stale running progress rows", async () => {
  const dbPath = join(tempDir, "app.sqlite");
  let server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  const result = await postJson(`${server.url}messages`, {
    chat_id: "general",
    text: "finish after progress",
  });
  const turnId = result.data.turn.id;
  const userMessageId = result.data.accepted.id;
  server.stop();

  appendTranscriptEvent(
    createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: "2026-05-18T12:02:00.000Z",
      payload: {
        actionId: `runtime-intermediate:app:${userMessageId}:web-search-progress`,
        accountId: "local",
        peer: { kind: "dm", id: "general" },
        message: {
          text: "",
          replyToMessageId: userMessageId,
        },
        metadata: {
          kind: "tool_progress",
          activityKind: "searched",
          toolName: "Web search",
          safeLabel: "Web search: stale",
          inputLabel: "stale",
          toolCallId: "tool-progress-stale",
          detailRows: [
            {
              id: "stale-detail",
              kind: "query",
              safe_label: "Query",
              safe_value: "stale",
              state: "running",
            },
          ],
        },
      },
    }),
  );
  appendTranscriptEvent(
    createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: "2026-05-18T12:02:01.000Z",
      payload: {
        actionId: "queued-inbound-reply:test:app:general:terminal-progress",
        accountId: "local",
        peer: { kind: "dm", id: "general" },
        message: {
          text: "Finished after progress.",
        },
        metadata: {
          kind: "final_result",
          turnId,
          source: "test",
        },
      },
    }),
  );

  server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  try {
    const messages = await getJson(`${server.url}messages?chat_id=general`);
    const rows = messages.data.turn_progress[turnId].safe_progress_rows;
    const searchRow = rows.find(
      (row: { kind: string }) => row.kind === "searched",
    );
    expect(rows).toContainEqual(
      expect.objectContaining({
        kind: "searched",
        state: "delivered",
        safe_tool_name: "Web search",
      }),
    );
    expect(searchRow?.safe_detail_rows[0]).toMatchObject({
      id: "stale-detail",
      state: "delivered",
    });

    const summary = await getJson(
      `${server.url}session-summary?session_id=general`,
    );
    expect(summary.data.latest_progress.state).toBe("delivered");
    expect(
      summary.data.latest_progress.safe_progress_rows.some(
        (row: { state: string }) => row.state === "running",
      ),
    ).toBe(false);
    const sessionView = await getJson(
      `${server.url}session-view?session_id=general`,
    );
    expect(sessionView.data.status).toBe("delivered");
    expect(sessionView.data.active_turn).toBeNull();
    expect(sessionView.data.latest_turn.state).toBe("delivered");
    expect(
      sessionView.data.latest_turn.progress.safe_progress_rows.some(
        (row: { state: string }) => row.state === "running",
      ),
    ).toBe(false);
  } finally {
    server.stop();
  }
});

test("app transport failure projection fails queued turns after app-server restart", async () => {
  const dbPath = join(tempDir, "app.sqlite");
  let server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  const url = server.url;
  const result = await postJson(`${url}messages`, {
    chat_id: "general",
    text: "this queued turn should fail safely",
  });
  const turnId = result.data.turn.id;
  expect(result.data.turn.state).toBe("thinking");
  server.stop();

  appendTranscriptEvent(
    createTranscriptEvent({
      sessionId: "butler/app-general",
      kind: "outbound",
      transport: "app",
      timestamp: "2026-05-18T12:01:00.000Z",
      payload: {
        actionId: "queued-inbound-failure:test:app:general",
        accountId: "local",
        peer: { kind: "dm", id: "general" },
        message: {
          text: "Butler could not complete this turn.",
        },
        metadata: {
          kind: "turn_failed",
          turnId,
          safeErrorCode: "gateway_failed",
          safeErrorCause: "provider socket token=secret",
          source: "test",
          privateDetail: "provider socket private stack",
        },
      },
    }),
  );

  server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  try {
    const messages = await getJson(`${server.url}messages?chat_id=general`);
    expect(
      messages.data.messages.map((message: { text: string }) => message.text),
    ).toEqual([
      "this queued turn should fail safely",
      "Butler could not complete this turn.",
    ]);
    const assistant = messages.data.messages.find(
      (message: { role: string }) => message.role === "assistant",
    );
    expect(assistant).toMatchObject({
      status: "failed",
      safe_error_code: "gateway_failed",
      retryable: true,
    });
    expect(JSON.stringify(messages)).not.toContain("private stack");
    expect(JSON.stringify(messages)).not.toContain("token=secret");

    const turns = await getJson(`${server.url}turns?chat_id=general`);
    expect(turns.data.turns).toHaveLength(1);
    expect(turns.data.turns[0]).toMatchObject({
      id: turnId,
      state: "failed",
      safe_error_code: "gateway_failed",
      cancellable: false,
      retryable: true,
    });
    const events = await getJson(`${server.url}events?cursor=0`);
    const failedEvent = events.data.events.find(
      (
        event: {
          type: string;
          payload?: { event?: { kind?: string; payload?: unknown } };
        },
      ) =>
        event.type === "agent.turn_event" &&
        event.payload?.event?.kind === "turn.failed",
    );
    expect(failedEvent?.payload?.event?.payload).toMatchObject({
      safeErrorCode: "gateway_failed",
    });
    expect(JSON.stringify(failedEvent?.payload?.event?.payload)).not.toContain(
      "safeCause",
    );
    expect(JSON.stringify(events)).not.toContain("token=secret");
    expect(JSON.stringify(events)).not.toContain("private stack");
  } finally {
    server.stop();
  }
});

test("retry without injected responder requeues the app turn instead of answering locally", async () => {
  const dbPath = join(tempDir, "app.sqlite");
  let server = createAppServer({
    dbPath,
    butlerData: tempDir,
    port: 0,
    responder() {
      throw new Error("provider failed");
    },
  });
  const first = await fetch(`${server.url}messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: "general",
      text: "retry through core",
    }),
  });
  expect(first.status).toBe(202);
  const failedTurn = await waitForLatestTurnMatching(
    server.url,
    "general",
    (turn) => turn.state === "failed",
  );
  const turnId = failedTurn.id as string;
  server.stop();

  server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  try {
    const retry = await postJson(
      `${server.url}turns/${encodeURIComponent(turnId)}/retry`,
      {},
    );
    expect(retry.data.replies).toHaveLength(0);
    expect(retry.data.turn).toMatchObject({
      id: turnId,
      state: "retrying",
      cancellable: true,
      attempt: 2,
    });
    const pending = readdirSync(
      join(tempDir, "runtime", "inbound-events", "pending"),
    );
    expect(pending).toHaveLength(1);
    const messages = await getJson(`${server.url}messages?chat_id=general`);
    expect(
      messages.data.messages.map(
        (message: { role: string; text: string; status: string }) => ({
          role: message.role,
          text: message.text,
          status: message.status,
        }),
      ),
    ).toEqual([
      {
        role: "user",
        text: "retry through core",
        status: "sent",
      },
    ]);
    expect(JSON.stringify(messages)).not.toContain("Retrying this turn");
  } finally {
    server.stop();
  }
});

test("retry ignores stale app transport failure projection from earlier attempts", async () => {
  const dbPath = join(tempDir, "app.sqlite");
  let server = createAppServer({
    dbPath,
    butlerData: tempDir,
    port: 0,
    responder() {
      throw new Error("provider failed");
    },
  });
  const first = await fetch(`${server.url}messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: "general",
      text: "retry with stale failure transcript",
    }),
  });
  expect(first.status).toBe(202);
  const failedTurn = await waitForLatestTurnMatching(
    server.url,
    "general",
    (turn) => turn.state === "failed",
  );
  const turnId = failedTurn.id as string;
  server.stop();

  server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
  try {
    const retry = await postJson(
      `${server.url}turns/${encodeURIComponent(turnId)}/retry`,
      {},
    );
    expect(retry.data.turn).toMatchObject({
      id: turnId,
      state: "retrying",
      attempt: 2,
    });

    appendTranscriptEvent(
      createTranscriptEvent({
        sessionId: "butler/app-general",
        kind: "outbound",
        transport: "app",
        timestamp: "2026-05-18T12:00:00.000Z",
        payload: {
          actionId: "queued-inbound-failure:test:app:general:stale-retry",
          accountId: "local",
          peer: { kind: "dm", id: "general" },
          message: {
            text: "Butler could not complete this turn.",
          },
          metadata: {
            kind: "turn_failed",
            turnId,
            safeErrorCode: "gateway_failed",
            source: "test",
          },
        },
      }),
    );

    const turns = await getJson(`${server.url}turns?chat_id=general`);
    expect(turns.data.turns[0]).toMatchObject({
      id: turnId,
      state: "retrying",
      cancellable: true,
      retryable: false,
      attempt: 2,
    });
    expect(turns.data.turns[0].safe_error_code ?? null).toBeNull();
  } finally {
    server.stop();
  }
});

test("message replay includes automatic compaction markers at the snapshot point", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
    responder(input) {
      return { texts: [`reply: ${input.text}`] };
    },
  });
  try {
    await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "before compaction",
    });

    const markerTime = new Date(Date.now() + 25).toISOString();
    const path = compactionPath(tempDir, "butler/app-general");
    mkdirSync(join(tempDir, "context", "compactions"), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({
        schema: "butler.context.compaction.v1",
        snapshot_id: "cmp_unit_marker",
        session_id: "butler/app-general",
        trigger: "auto",
        status: "ok",
        created_at: markerTime,
        model_ref: "openai/gpt-5.5",
        model_context_window_tokens: 258_000,
        pre_estimated_tokens: 180_000,
        post_estimated_tokens: 24_000,
        summarized_event_range: {
          first_event_id: "event-1",
          last_event_id: "event-2",
          event_count: 2,
        },
        preserved_suffix_event_ids: ["event-3"],
        summary: "privacy safe summary",
        provenance: ["event-1", "event-2"],
        diagnostics: [],
      })}\n`,
      "utf8",
    );

    await new Promise((resolve) => setTimeout(resolve, 35));
    await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "after compaction",
    });

    const messages = await getJson(
      `${server.url}messages?chat_id=general&cursor=0`,
    );
    expect(
      messages.data.messages.map((message: { text: string }) => message.text),
    ).toEqual([
      "before compaction",
      "reply: before compaction",
      "Context automatically compacting",
      "Context automatically compacted",
      "after compaction",
      "reply: after compaction",
    ]);
    const marker = messages.data.messages.find(
      (message: { text: string }) =>
        message.text === "Context automatically compacted",
    );
    expect(marker).toMatchObject({
      role: "system_event",
      status: "delivered",
      retryable: false,
    });
    expect(JSON.stringify(messages)).not.toContain("privacy safe summary");
  } finally {
    server.stop();
  }
});

test("message files are uploaded, served safely, and attached by file id only", async () => {
  const pngBytes = new Uint8Array([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13,
  ]);
  const responderInputs: Array<{ attachments?: unknown[] }> = [];
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
    responder(input) {
      responderInputs.push({ attachments: input.attachments });
      return {
        texts: ["attachment received"],
        files: [
          {
            name: "/Users/private/result.txt",
            mimeType: "text/plain",
            bytes: "assistant file",
          },
        ],
      };
    },
  });
  try {
    const uploadForm = new FormData();
    uploadForm.set("session_id", "general");
    uploadForm.set(
      "file",
      new Blob([pngBytes], { type: "image/png" }),
      "private screenshot.png",
    );
    const uploadResponse = await fetch(`${server.url}message-files`, {
      method: "POST",
      body: uploadForm,
    });
    const uploaded = await uploadResponse.json();
    expect(uploadResponse.status).toBe(201);
    expect(uploaded.data.file).toMatchObject({
      kind: "image",
      mime_type: "image/png",
      safe_name: "private screenshot.png",
      size_bytes: pngBytes.byteLength,
    });
    expect(uploaded.data.file.file_id).toMatch(/^file-/);
    expect(uploaded.data.file.url).toBe(
      `/message-files/${uploaded.data.file.file_id}`,
    );
    expect(JSON.stringify(uploaded)).not.toContain(tempDir);
    expect(JSON.stringify(uploaded)).not.toContain("data:image");

    const downloadResponse = await fetch(
      `${server.url}${uploaded.data.file.url.slice(1)}`,
    );
    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers.get("content-type")).toBe("image/png");
    expect(downloadResponse.headers.get("cache-control")).toBe("no-store");
    expect(downloadResponse.headers.get("content-disposition")).toContain(
      "filename=",
    );
    expect(new Uint8Array(await downloadResponse.arrayBuffer())).toEqual(
      pngBytes,
    );

    const sent = await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "please inspect attachment",
      attachments: [{ file_id: uploaded.data.file.file_id }],
    });
    expect(sent.data.accepted.attachments).toEqual([uploaded.data.file]);
    expect(responderInputs[0]?.attachments).toEqual([uploaded.data.file]);
    const reply = await waitForAssistantMessageMatching(
      server.url,
      "general",
      (message) => message.text === "attachment received",
    );
    const replyAttachments = reply.attachments as Array<Record<string, unknown>>;
    expect(replyAttachments[0]).toMatchObject({
      kind: "text",
      mime_type: "text/plain",
      safe_name: "result.txt",
    });
    const replyArtifacts = reply.artifacts as Array<Record<string, unknown>>;
    expect(replyArtifacts[0]).toMatchObject({
      file_id: replyAttachments[0]?.file_id,
      message_id: reply.id,
      turn_id: reply.turn_id,
      title: "result.txt",
      kind: "document",
      open_action: "route",
      url: replyAttachments[0]?.url,
    });

    const messages = await getJson(
      `${server.url}messages?chat_id=general&cursor=0`,
    );
    expect(messages.data.messages[0].attachments).toEqual([uploaded.data.file]);
    expect(messages.data.messages[1].attachments[0].file_id).toMatch(/^file-/);
    expect(messages.data.messages[1].artifacts[0]).toMatchObject({
      file_id: messages.data.messages[1].attachments[0].file_id,
      message_id: messages.data.messages[1].id,
      title: "result.txt",
    });
    expect(JSON.stringify(messages)).not.toContain(tempDir);
    expect(JSON.stringify(messages)).not.toContain("/Users/private");
    expect(JSON.stringify(messages)).not.toContain("assistant file");
    expect(JSON.stringify(messages)).not.toContain("data:image");

    const artifacts = await getJson(
      `${server.url}artifacts?session_id=general`,
    );
    expect(artifacts.data.artifacts).toEqual([
      expect.objectContaining({
        file_id: replyAttachments[0]?.file_id,
        message_id: reply.id,
        title: "result.txt",
        open_action: "route",
      }),
    ]);

    const summary = await getJson(
      `${server.url}session-summary?session_id=general`,
    );
    expect(summary.data.artifacts).toEqual(artifacts.data.artifacts);

    const context = await getJson(
      `${server.url}context-details?session_id=general`,
    );
    const referenceCategory = context.data.categories.find(
      (category: { id: string }) => category.id === "references",
    );
    expect(referenceCategory?.used_tokens).toBeGreaterThanOrEqual(64);

    const corruptForm = new FormData();
    corruptForm.set("session_id", "general");
    corruptForm.set(
      "file",
      new Blob([pngBytes], { type: "image/png" }),
      "corrupt.png",
    );
    const corruptUploadResponse = await fetch(`${server.url}message-files`, {
      method: "POST",
      body: corruptForm,
    });
    const corruptUpload = await corruptUploadResponse.json();
    server.store.db
      .query("UPDATE message_files SET storage_name = ? WHERE id = ?")
      .run("../escape", corruptUpload.data.file.file_id);
    const corruptDownload = await fetch(
      `${server.url}${corruptUpload.data.file.url.slice(1)}`,
    );
    expect(corruptDownload.status).toBe(404);
  } finally {
    server.stop();
  }
});

test("message file refs reject unknown, cross-session, and reused file ids", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
  });
  try {
    const uploadForm = new FormData();
    uploadForm.set("session_id", "general");
    uploadForm.set(
      "file",
      new Blob(["hello"], { type: "text/plain" }),
      "note.txt",
    );
    const uploadResponse = await fetch(`${server.url}message-files`, {
      method: "POST",
      body: uploadForm,
    });
    const uploaded = await uploadResponse.json();
    expect(uploadResponse.ok).toBe(true);
    const otherChat = await postJson(`${server.url}sessions`, {
      kind: "chat",
      title: "Other upload session",
    });

    const wrongSession = await fetch(`${server.url}messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: otherChat.data.session.id,
        text: "wrong session",
        attachments: [{ file_id: uploaded.data.file.file_id }],
      }),
    });
    const wrongBody = await wrongSession.json();
    expect(wrongSession.status).toBe(403);
    expect(wrongBody.error.code).toBe("message_file_wrong_session");

    await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "first send",
      attachments: [{ file_id: uploaded.data.file.file_id }],
    });
    const reused = await fetch(`${server.url}messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: "general",
        text: "second send",
        attachments: [{ file_id: uploaded.data.file.file_id }],
      }),
    });
    const reusedBody = await reused.json();
    expect(reused.status).toBe(409);
    expect(reusedBody.error.code).toBe("message_file_already_attached");

    const unknown = await fetch(`${server.url}messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: "general",
        text: "unknown file",
        attachments: [{ file_id: "file-00000000-0000-4000-8000-000000000000" }],
      }),
    });
    const unknownBody = await unknown.json();
    expect(unknown.status).toBe(400);
    expect(unknownBody.error.code).toBe("message_file_not_found");
  } finally {
    server.stop();
  }
});

test("app slash update command uses the service updater without routing to the model", async () => {
  const updateManifestPath = join(tempDir, "service-update-manifest.json");
  writeServiceUpdateManifest(updateManifestPath, packageVersion);
  process.env.BUTLER_UPDATE_MANIFEST = updateManifestPath;
  const runtime = new ScriptedRuntime("unexpected model reply");
  const bridge = new AppGatewayBridge({
    butlerHome: process.cwd(),
    butlerData: tempDir,
    runtime,
    provider: fakeProvider,
    sessionTitleGenerator: false,
  });
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
    responder: bridge.responder,
  });
  try {
    const check = await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "/update",
    });
    expect(check.data.turn.state).toBe("thinking");
    const checkReply = await waitForAssistantMessageMatching(
      server.url,
      "general",
      (message) =>
        message.text === `Butler Agent is up to date (${packageVersion}).`,
    );
    expect(checkReply.text).toBe(
      `Butler Agent is up to date (${packageVersion}).`,
    );
    expect(runtime.turns).toHaveLength(0);

    const apply = await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "/update apply",
    });
    expect(apply.data.turn.state).toBe("thinking");
    const applyReply = await waitForAssistantMessageMatching(
      server.url,
      "general",
      (message) =>
        message.text === `Butler Agent is up to date (${packageVersion}).`,
    );
    expect(applyReply.text).toBe(
      `Butler Agent is up to date (${packageVersion}).`,
    );
    await waitForCondition(() =>
      existsSync(join(tempDir, "updates", "staged", "service.json")),
    );
    expect(existsSync(join(tempDir, "updates", "staged", "service.json"))).toBe(
      true,
    );
    expect(runtime.turns).toHaveLength(0);
  } finally {
    server.stop();
    bridge.close();
  }
});

test("app server can route messages through Butler gateway bridge", async () => {
  const runtimeArtifactPath = join(tempDir, "runtime-result.csv");
  writeFileSync(runtimeArtifactPath, "name,count\nbutler,1\n", "utf8");
  const runtime = new ScriptedRuntime("gateway bridge reply", undefined, [
    {
      id: "runtime-result",
      kind: "csv_file",
      title: "runtime-result.csv",
      safePathLabel: "runtime-result.csv",
      localPath: runtimeArtifactPath,
      mimeType: "text/csv",
    },
  ]);
  const bridge = new AppGatewayBridge({
    butlerHome: tempDir,
    butlerData: tempDir,
    runtime,
    provider: fakeProvider,
  });
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
    responder: bridge.responder,
  });
  try {
    const uploadForm = new FormData();
    uploadForm.set("session_id", "general");
    uploadForm.set(
      "file",
      new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], {
        type: "image/png",
      }),
      "gateway.png",
    );
    const uploadResponse = await fetch(`${server.url}message-files`, {
      method: "POST",
      body: uploadForm,
    });
    expect(uploadResponse.ok).toBe(true);
    const uploaded = await uploadResponse.json();
    const result = await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "route this",
      attachments: [{ file_id: uploaded.data.file.file_id }],
    });
    expect(result.data.turn.state).toBe("thinking");
    const reply = await waitForAssistantMessageMatching(
      server.url,
      "general",
      (message) => message.text === "gateway bridge reply",
    );
    const replyAttachments = reply.attachments as Array<Record<string, unknown>>;
    const replyArtifacts = reply.artifacts as Array<Record<string, unknown>>;
    expect(replyAttachments[0]).toMatchObject({
      kind: "text",
      mime_type: "text/csv",
      safe_name: "runtime-result.csv",
    });
    expect(replyArtifacts[0]).toMatchObject({
      file_id: replyAttachments[0]?.file_id,
      title: "runtime-result.csv",
      kind: "csv_file",
      open_action: "route",
    });
    expect(JSON.stringify(reply)).not.toContain(runtimeArtifactPath);
    expect(JSON.stringify(readTranscript("butler/app-general"))).not.toContain(
      runtimeArtifactPath,
    );
    expect(runtime.turns[0]?.input).toMatchObject({
      transport: "app",
      message: {
        text: "route this",
        attachments: [
          expect.objectContaining({
            id: uploaded.data.file.file_id,
            kind: "image",
            mimeType: "image/png",
            fileName: "gateway.png",
            url: uploaded.data.file.url,
          }),
        ],
      },
      routingHints: {
        sessionId: "butler/app-general",
      },
    });
  } finally {
    server.stop();
    bridge.close();
  }
});

test("app server preserves Korean artifact filenames in gateway replies", async () => {
  const artifactName = "충주 행사 결과.csv";
  const runtimeArtifactPath = join(tempDir, artifactName);
  writeFileSync(runtimeArtifactPath, "name,count\n중원문화제,1\n", "utf8");
  const runtime = new ScriptedRuntime("gateway bridge reply", undefined, [
    {
      id: "korean-runtime-result",
      kind: "csv_file",
      title: artifactName,
      safePathLabel: artifactName,
      localPath: runtimeArtifactPath,
      mimeType: "text/csv",
    },
  ]);
  const bridge = new AppGatewayBridge({
    butlerHome: tempDir,
    butlerData: tempDir,
    runtime,
    provider: fakeProvider,
  });
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
    responder: bridge.responder,
  });
  try {
    const result = await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "route korean artifact",
    });
    expect(result.data.turn.state).toBe("thinking");
    const reply = await waitForAssistantMessageMatching(
      server.url,
      "general",
      (message) => message.text === "gateway bridge reply",
    );
    const replyAttachments = reply.attachments as Array<Record<string, unknown>>;
    const replyArtifacts = reply.artifacts as Array<Record<string, unknown>>;
    expect(replyAttachments[0]).toMatchObject({
      kind: "text",
      mime_type: "text/csv",
      safe_name: artifactName,
    });
    expect(replyAttachments[0]?.safe_name).not.toContain("_");
    expect(replyArtifacts[0]).toMatchObject({
      file_id: replyAttachments[0]?.file_id,
      title: artifactName,
      kind: "csv_file",
      open_action: "route",
    });
  } finally {
    server.stop();
    bridge.close();
  }
});

test("app server opens Korean generated artifact labels through message files", async () => {
  const artifactTitle = "국내 시판 소시지 돼지고기 함량 비교";
  const artifactName =
    "국내-시판-소시지-돼지고기-함량-비교-public-data-test.csv";
  const artifactDir = join(tempDir, "artifacts", "public-data");
  mkdirSync(artifactDir, { recursive: true });
  const runtimeArtifactPath = join(artifactDir, artifactName);
  writeFileSync(runtimeArtifactPath, "name,count\n중원문화제,1\n", "utf8");
  const runtime = new ScriptedRuntime("gateway bridge reply", undefined, [
    {
      id: "korean-generated-result",
      kind: "csv_file",
      title: artifactTitle,
      safePathLabel: artifactName,
      localPath: runtimeArtifactPath,
      mimeType: "text/csv",
    },
  ]);
  const bridge = new AppGatewayBridge({
    butlerHome: tempDir,
    butlerData: tempDir,
    runtime,
    provider: fakeProvider,
  });
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
    responder: bridge.responder,
  });
  try {
    const result = await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "route korean generated artifact",
    });
    expect(result.data.turn.state).toBe("thinking");
    const reply = await waitForAssistantMessageMatching(
      server.url,
      "general",
      (message) => message.text === "gateway bridge reply",
    );
    const replyAttachments = reply.attachments as Array<Record<string, unknown>>;
    const replyArtifacts = reply.artifacts as Array<Record<string, unknown>>;
    expect(replyAttachments[0]).toMatchObject({
      kind: "text",
      mime_type: "text/csv",
      safe_name: artifactName,
    });
    expect(replyArtifacts[0]).toMatchObject({
      file_id: replyAttachments[0]?.file_id,
      title: artifactName,
      kind: "csv_file",
      open_action: "route",
      url: `/message-files/${replyAttachments[0]?.file_id}`,
    });

    const download = await fetch(
      new URL(String(replyArtifacts[0]?.url), server.url),
    );
    expect(download.ok).toBe(true);
    expect(await download.text()).toContain("중원문화제");
    const disposition = download.headers.get("content-disposition") ?? "";
    expect(disposition).toContain("filename=");
    expect(disposition).toContain("filename*=");
    expect(disposition).toContain(encodeURIComponent(artifactName));
  } finally {
    server.stop();
    bridge.close();
  }
});

test("app gateway bridge completes reporting WorkStreams after handled app turns", async () => {
  const now = new Date().toISOString();
  const todoItemInput = (
    id: string,
    status: "completed" | "in_progress",
    phase: "planning" | "execution" | "review" | "consolidation" | "reporting",
  ) => ({
    id,
    content: `${id} 하기`,
    active_form: `${id} 하기`,
    status,
    phase,
    priority: "normal" as const,
  });
  const runtime = new ScriptedRuntime("gateway bridge reply", (turn) => {
    const todoView = new TodoListStore(tempDir).update({
      listId: "main",
      title: "브랜치 및 스크립트 확인",
      now: new Date(now),
      items: [
        todoItemInput("plan", "completed", "planning"),
        todoItemInput("inspect", "completed", "execution"),
        todoItemInput("review", "completed", "review"),
        todoItemInput("consolidate", "completed", "consolidation"),
        todoItemInput("report", "in_progress", "reporting"),
      ],
    });
    new WorkStreamStore(tempDir).updateFromTodoList({
      ownerSessionId: turn.handle.sessionId,
      listId: "main",
      title: "브랜치 및 스크립트 확인",
      items: todoView.list.items,
    });
  });
  const bridge = new AppGatewayBridge({
    butlerHome: tempDir,
    butlerData: tempDir,
    runtime,
    provider: fakeProvider,
  });
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
    responder: bridge.responder,
  });
  try {
    await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "route this",
    });

    const streams = new WorkStreamStore(tempDir).list({
      sessionId: "butler/app-general",
      includeTerminal: true,
    });
    expect(streams).toHaveLength(1);
    expect(streams[0].state).toBe("complete");
    expect(streams[0].active_step_id).toBeNull();
    const todos = new TodoListStore(tempDir).view("main", {
      includeCompleted: true,
    });
    expect(todos.progress).toMatchObject({
      completed: 5,
      in_progress: 0,
      progress_pct: 100,
    });
    expect(todos.list.items.find((item) => item.id === "report")).toMatchObject(
      {
        status: "completed",
        phase: "reporting",
      },
    );
  } finally {
    server.stop();
    bridge.close();
  }
});

test("app gateway bridge persists final runtime text before the next app turn", async () => {
  const firstFinal = "FIRST_APP_GATEWAY_FINAL_SENTINEL";
  let turnCount = 0;
  const runtime = new ScriptedRuntime(() => {
    turnCount += 1;
    if (turnCount === 2) {
      const transcript = readTranscript("butler/app-general");
      expect(transcript).toContainEqual(
        expect.objectContaining({
          kind: "outbound",
          payload: expect.objectContaining({
            message: expect.objectContaining({
              text: firstFinal,
            }),
          }),
        }),
      );
      return "SECOND_APP_GATEWAY_SAW_FIRST";
    }
    return firstFinal;
  });
  const bridge = new AppGatewayBridge({
    butlerHome: tempDir,
    butlerData: tempDir,
    runtime,
    provider: fakeProvider,
  });
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
    responder: bridge.responder,
  });
  try {
    const first = await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "first app turn",
    });
    expect(first.data.turn.state).toBe("thinking");
    const firstReply = await waitForAssistantMessageMatching(
      server.url,
      "general",
      (message) => message.text === firstFinal,
    );
    expect(firstReply.text).toBe(firstFinal);

    const second = await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "second app turn",
    });
    expect(second.data.turn.state).toBe("thinking");
    const secondReply = await waitForAssistantMessageMatching(
      server.url,
      "general",
      (message) => message.text === "SECOND_APP_GATEWAY_SAW_FIRST",
    );
    expect(secondReply.text).toBe("SECOND_APP_GATEWAY_SAW_FIRST");
    expect(runtime.turns[1]?.input).toMatchObject({
      routingHints: {
        turnId: second.data.turn.id,
      },
    });
  } finally {
    server.stop();
    bridge.close();
  }
});

for (const staleState of ["closed", "crashed"] as const) {
  test(`app gateway bridge reactivates ${staleState} app bindings before routing local model messages`, async () => {
    const runtime = new ScriptedRuntime("local bridge reply");
    const bridge = new AppGatewayBridge({
      butlerHome: tempDir,
      butlerData: tempDir,
      runtime,
      provider: fakeProvider,
    });
    const staleStore = new SessionBindingStore(
      join(tempDir, "runtime", "session-store.sqlite"),
    );
    staleStore.updateLifecycleState(
      "butler/app-general",
      staleState,
      new Date().toISOString(),
    );
    staleStore.close();
    const server = createAppServer({
      dbPath: join(tempDir, "app.sqlite"),
      butlerData: tempDir,
      port: 0,
      responder: bridge.responder,
    });
    try {
      await postJson(`${server.url}model-catalog/local-models`, {
        provider_id: "local",
        api_type: "openai_compatible",
        platform: "llama_cpp",
        server_url: "http://127.0.0.1:8080",
        model_id: "gemma-route",
        display_name: "Gemma Route",
        context_window_tokens: 16_384,
        source: "manual",
      });
      const result = await postJson(`${server.url}messages`, {
        chat_id: "general",
        text: "route this locally",
        model: "local/gemma-route",
        reasoning_effort: "none",
      });
      expect(result.data.turn.state).toBe("thinking");
      const reply = await waitForAssistantMessageMatching(
        server.url,
        "general",
        (message) => message.text === "local bridge reply",
      );
      expect(reply.text).toBe("local bridge reply");
      expect(runtime.turns[0]?.model).toBe("local/gemma-route");
      expect(runtime.turns[0]?.input).toMatchObject({
        routingHints: {
          sessionId: "butler/app-general",
        },
      });
    } finally {
      server.stop();
      bridge.close();
    }
  });
}

test("app gateway bridge captures tool progress without blank assistant messages", async () => {
  const runtime = new ScriptedRuntime(
    (turn) =>
      `gateway bridge reply: ${
        "message" in turn.input ? turn.input.message.text : turn.input.text
      }`,
    async (turn) => {
      if (!("eventId" in turn.input)) return;
      await turn.emitIntermediateDelivery?.(
        {
          actionId: `runtime-intermediate:${turn.input.eventId}:bash-progress`,
          transport: turn.input.transport,
          accountId: turn.input.accountId,
          peer: {
            kind: turn.input.peer.kind,
            id: turn.input.peer.id,
          },
          message: {
            text: "",
            replyToMessageId: turn.input.message.id,
          },
          metadata: {
            kind: "tool_progress",
            activityKind: "ran_command",
            toolName: "Bash",
            safeLabel: `Bash: ${turn.input.message.text}`,
            inputLabel: turn.input.message.text,
            workBlockId: "work-progress",
            workBlockLabel: "상태를 확인하는 중",
            decisionSummary: "상태 확인을 위해 Bash를 실행합니다.",
            decisionSource: "assistant-authored",
            detailRows: [
              {
                id: "bridge-progress-command",
                kind: "command",
                safe_label: "Command",
                safe_value: turn.input.message.text,
                state: "running",
              },
            ],
          },
        },
        {
          kind: "tool_progress",
        },
      );
    },
  );
  const bridge = new AppGatewayBridge({
    butlerHome: tempDir,
    butlerData: tempDir,
    runtime,
    provider: fakeProvider,
  });
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
    responder: bridge.responder,
  });
  try {
    const result = await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "route this with progress",
    });
    expect(result.data.turn.state).toBe("thinking");
    const firstReply = await waitForAssistantMessageMatching(
      server.url,
      "general",
      (message) =>
        message.text === "gateway bridge reply: route this with progress",
    );
    expect(firstReply.text).toBe("gateway bridge reply: route this with progress");
    const second = await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "route this again",
    });
    expect(second.data.turn.state).toBe("thinking");
    const secondReply = await waitForAssistantMessageMatching(
      server.url,
      "general",
      (message) => message.text === "gateway bridge reply: route this again",
    );
    expect(secondReply.text).toBe("gateway bridge reply: route this again");

    const messages = await getJson(
      `${server.url}messages?chat_id=general&cursor=0`,
    );
    expect(
      messages.data.messages.map((message: { text: string }) => message.text),
    ).toEqual([
      "route this with progress",
      "gateway bridge reply: route this with progress",
      "route this again",
      "gateway bridge reply: route this again",
    ]);
    const assistantTurnIds = messages.data.messages
      .filter((message: { role: string }) => message.role === "assistant")
      .map((message: { turn_id?: string }) => message.turn_id);
    expect(new Set(assistantTurnIds).size).toBe(2);
    for (const turnId of assistantTurnIds) {
      expect(messages.data.turn_progress[turnId]).toMatchObject({
        turn_id: turnId,
        state: "delivered",
      });
      expect(messages.data.turn_progress[turnId].safe_progress_rows).toContainEqual(
        expect.objectContaining({
          kind: "ran_command",
          safe_tool_name: "Bash",
        }),
      );
    }
    const secondAssistant = messages.data.messages.find(
      (message: { role: string; text: string }) =>
        message.role === "assistant" &&
        message.text === "gateway bridge reply: route this again",
    );
    expect(secondAssistant?.work_blocks?.[0]).toMatchObject({
      id: "work-progress",
      label: "상태를 확인하는 중",
      decision_summary: "상태 확인을 위해 Bash를 실행합니다.",
    });
    expect(secondAssistant?.work_blocks?.[0]?.rows[0]).toMatchObject({
      safe_tool_name: "Bash",
      safe_input_label: "route this again",
    });
    expect(secondAssistant?.work_blocks?.[0]?.rows[0].work_block_id)
      .toBeUndefined();
    expect(secondAssistant?.work_blocks?.[0]?.rows[0].work_block_label)
      .toBeUndefined();
    expect(secondAssistant?.work_blocks?.[0]?.rows[0].work_decision_summary)
      .toBeUndefined();
    const summary = await getJson(
      `${server.url}session-summary?session_id=general`,
    );
    expect(summary.data.latest_progress.safe_progress_rows).toContainEqual(
      expect.objectContaining({
        kind: "ran_command",
        safe_tool_name: "Bash",
        safe_input_label: "route this again",
      }),
    );
  } finally {
    server.stop();
    bridge.close();
  }
});

test("app gateway bridge projects todo progress as semantic steps", async () => {
  const runtime = new ScriptedRuntime("gateway bridge reply", async (turn) => {
    if (!("eventId" in turn.input)) return;
    await turn.emitIntermediateDelivery?.(
      {
        actionId: `runtime-intermediate:${turn.input.eventId}:todo-progress`,
        transport: turn.input.transport,
        accountId: turn.input.accountId,
        peer: {
          kind: turn.input.peer.kind,
          id: turn.input.peer.id,
        },
        message: {
          text: "",
          replyToMessageId: turn.input.message.id,
        },
        metadata: {
          kind: "todo_progress",
          safeLabel: "자료 수집하기",
          state: "running",
          phase: "execution",
        },
      },
      {
        kind: "todo_progress",
        safeLabel: "자료 수집하기",
        state: "running",
        phase: "execution",
      },
    );
  });
  const bridge = new AppGatewayBridge({
    butlerHome: tempDir,
    butlerData: tempDir,
    runtime,
    provider: fakeProvider,
  });
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
    responder: bridge.responder,
  });
  try {
    await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "route this with todo progress",
    });

    const summary = await getJson(
      `${server.url}session-summary?session_id=general`,
    );
    expect(summary.data.latest_progress.safe_progress_rows).toContainEqual(
      expect.objectContaining({
        kind: "todo",
        safe_label: "자료 수집하기",
        state: "delivered",
        safe_detail_rows: [
          expect.objectContaining({
            kind: "phase",
            safe_label: "Phase",
            safe_value: "실행",
          }),
        ],
      }),
    );
    expect(
      JSON.stringify(summary.data.latest_progress.safe_progress_rows),
    ).not.toContain("update_todo_list");
    expect(
      JSON.stringify(summary.data.latest_progress.safe_progress_rows),
    ).not.toContain("Update Todo List");
    const messages = await getJson(
      `${server.url}messages?chat_id=general&cursor=0`,
    );
    const assistant = messages.data.messages.find(
      (message: { role: string }) => message.role === "assistant",
    );
    expect(assistant?.work_blocks).toBeUndefined();
  } finally {
    server.stop();
    bridge.close();
  }
});

test("session summary merges todo progress updates by stable todo identity", async () => {
  const runtime = new ScriptedRuntime("gateway bridge reply", async (turn) => {
    if (!("eventId" in turn.input)) return;
    const baseAction = {
      transport: turn.input.transport,
      accountId: turn.input.accountId,
      peer: {
        kind: turn.input.peer.kind,
        id: turn.input.peer.id,
      },
      message: {
        text: "",
        replyToMessageId: turn.input.message.id,
      },
    };
    await turn.emitIntermediateDelivery?.(
      {
        ...baseAction,
        actionId: `runtime-intermediate:${turn.input.eventId}:todo-progress-running`,
        metadata: {
          kind: "todo_progress",
          todoId: "inspect",
          safeLabel: "프로젝트 메타정보와 구조 확인 중",
          state: "running",
          phase: "execution",
        },
      },
      {
        kind: "todo_progress",
        todoId: "inspect",
        safeLabel: "프로젝트 메타정보와 구조 확인 중",
        state: "running",
        phase: "execution",
      },
    );
    await turn.emitIntermediateDelivery?.(
      {
        ...baseAction,
        actionId: `runtime-intermediate:${turn.input.eventId}:todo-progress-delivered`,
        metadata: {
          kind: "todo_progress",
          todoId: "inspect",
          safeLabel: "프로젝트 메타정보와 구조 확인",
          state: "delivered",
          phase: "execution",
        },
      },
      {
        kind: "todo_progress",
        todoId: "inspect",
        safeLabel: "프로젝트 메타정보와 구조 확인",
        state: "delivered",
        phase: "execution",
      },
    );
  });
  const bridge = new AppGatewayBridge({
    butlerHome: tempDir,
    butlerData: tempDir,
    runtime,
    provider: fakeProvider,
  });
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    port: 0,
    responder: bridge.responder,
  });
  try {
    await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "route this with todo progress updates",
    });

    const summary = await getJson(
      `${server.url}session-summary?session_id=general`,
    );
    const todoRows = summary.data.latest_progress.safe_progress_rows.filter(
      (row: { kind?: string }) => row.kind === "todo",
    );
    expect(todoRows).toHaveLength(1);
    expect(todoRows[0]).toMatchObject({
      kind: "todo",
      safe_input_label: "inspect",
      safe_label: "프로젝트 메타정보와 구조 확인",
      state: "delivered",
    });
  } finally {
    server.stop();
    bridge.close();
  }
});

test("session summary preserves long active turn work history without latest-three truncation", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
    responder(input) {
      for (let index = 0; index < 40; index += 1) {
        input.onProgress?.({
          id: `work-row-${index}`,
          kind: "ran_command",
          state: "running",
          safe_label: `작업 단계 ${index + 1}`,
          safe_tool_name: "Bash",
          safe_input_label: `step-${index + 1}`,
          tool_call_id: `tool-${index}`,
          work_block_id: `work-block-${index}`,
          work_block_label: `작업 단계 ${index + 1}`,
        });
      }
      return { texts: ["done"] };
    },
  });
  try {
    await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "build a long visible work trace",
    });

    const summary = await getJson(
      `${server.url}session-summary?session_id=general`,
    );
    const rows = summary.data.latest_progress.safe_progress_rows as Array<{
      kind?: string;
      safe_label: string;
    }>;
    const workRows = rows.filter((row) =>
      row.safe_label.startsWith("작업 단계"),
    );

    expect(workRows).toHaveLength(40);
    expect(workRows[0]?.safe_label).toBe("작업 단계 1");
    expect(workRows.at(-1)?.safe_label).toBe("작업 단계 40");
  } finally {
    server.stop();
  }
});

test("session summary drops unauthorised legacy progress decision fields", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
    responder(input) {
      input.onProgress?.({
        id: "runtime-derived-decision",
        kind: "ran_command",
        state: "running",
        safe_label: "Checking local status",
        safe_tool_name: "Bash",
        safe_input_label: "status",
        work_block_id: "work-runtime-derived",
        work_decision_summary: "Fallback summary must not render as a decision",
        work_decision_rationale: "Runtime-derived text is diagnostic only.",
        work_decision_next_step: "Do not show this as model intent.",
        work_decision_source: "runtime-derived",
        work_decision_evidence_refs: ["diagnostic"],
      });
      return { texts: ["done"] };
    },
  });
  try {
    await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "check status",
    });

    const summary = await getJson(
      `${server.url}session-summary?session_id=general`,
    );
    const row = summary.data.latest_progress.safe_progress_rows.find(
      (candidate: { id?: string }) => candidate.id === "runtime-derived-decision",
    );
    expect(row).toMatchObject({
      safe_label: "Checking local status",
      work_block_id: "work-runtime-derived",
    });
    expect(row.work_decision_summary).toBeUndefined();
    expect(row.work_decision_source).toBeUndefined();
  } finally {
    server.stop();
  }
});

test("session summary resolves legacy running rows with delivered turn events", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
    responder(input) {
      input.onProgress?.({
        id: "legacy-project-ledger-running",
        kind: "ran_command",
        state: "running",
        safe_label: "Checking Project Ledger status",
        safe_tool_name: "Project Ledger",
        safe_input_label: "status",
      });
      input.onTurnEvent?.({
        kind: "tool.completed",
        payload: {
          toolCallId: "tool-project-ledger-status",
          workBlockId: "work-project-ledger-status",
          workBlockLabel: "Checking Project Ledger status",
          activityKind: "ran_command",
          toolName: "Project Ledger",
          inputLabel: "status",
          safeLabel: "Checking Project Ledger status",
        },
      });
      return { texts: ["done"] };
    },
  });
  try {
    await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "check status",
    });

    const summary = await getJson(
      `${server.url}session-summary?session_id=general`,
    );
    const rows = summary.data.latest_progress.safe_progress_rows as Array<{
      safe_label: string;
      state: string;
      safe_tool_name?: string;
      safe_input_label?: string;
    }>;
    const projectLedgerRows = rows.filter(
      (row) => row.safe_label === "Checking Project Ledger status",
    );

    expect(summary.data.latest_progress.state).toBe("delivered");
    expect(projectLedgerRows).toHaveLength(1);
    expect(projectLedgerRows[0]).toMatchObject({
      safe_label: "Checking Project Ledger status",
      state: "delivered",
    });
  } finally {
    server.stop();
  }
});

test("session summary absorbs late legacy running rows after delivered turn events", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
    responder(input) {
      input.onTurnEvent?.({
        kind: "tool.completed",
        payload: {
          toolCallId: "tool-project-ledger-status",
          workBlockId: "work-project-ledger-status",
          workBlockLabel: "Checking Project Ledger status",
          activityKind: "ran_command",
          toolName: "Project Ledger",
          inputLabel: "status",
          safeLabel: "Checking Project Ledger status",
        },
      });
      input.onProgress?.({
        id: "legacy-project-ledger-running-late",
        kind: "ran_command",
        state: "running",
        safe_label: "Checking Project Ledger status",
        safe_tool_name: "Project Ledger",
        safe_input_label: "status",
      });
      return { texts: ["done"] };
    },
  });
  try {
    await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "check status",
    });

    const summary = await getJson(
      `${server.url}session-summary?session_id=general`,
    );
    const rows = summary.data.latest_progress.safe_progress_rows as Array<{
      safe_label: string;
      state: string;
      safe_tool_name?: string;
      safe_input_label?: string;
      tool_call_id?: string;
    }>;
    const projectLedgerRows = rows.filter(
      (row) => row.safe_label === "Checking Project Ledger status",
    );

    expect(summary.data.latest_progress.state).toBe("delivered");
    expect(projectLedgerRows).toHaveLength(1);
    expect(projectLedgerRows[0]).toMatchObject({
      state: "delivered",
      safe_tool_name: "Project Ledger",
      safe_input_label: "status",
      tool_call_id: "tool-project-ledger-status",
    });
  } finally {
    server.stop();
  }
});

test("session summary keeps same-label progress rows separate when detail evidence conflicts", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
    responder(input) {
      input.onTurnEvent?.({
        kind: "tool.completed",
        payload: {
          toolCallId: "tool-project-ledger-status-a",
          workBlockId: "work-project-ledger-status-a",
          workBlockLabel: "Checking Project Ledger status",
          activityKind: "ran_command",
          toolName: "Project Ledger",
          inputLabel: "status",
          safeLabel: "Checking Project Ledger status",
          detailRows: [
            {
              id: "project-ledger-workspace",
              kind: "workspace",
              safe_label: "Workspace",
              safe_value: "~/project-a",
              state: "delivered",
            },
          ],
        },
      });
      input.onProgress?.({
        id: "legacy-project-ledger-running-b",
        kind: "ran_command",
        state: "running",
        safe_label: "Checking Project Ledger status",
        safe_tool_name: "Project Ledger",
        safe_input_label: "status",
        safe_detail_rows: [
          {
            id: "project-ledger-workspace",
            kind: "workspace",
            safe_label: "Workspace",
            safe_value: "~/project-b",
            state: "running",
          },
        ],
      });
      return { texts: ["done"] };
    },
  });
  try {
    await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "check status",
    });

    const summary = await getJson(
      `${server.url}session-summary?session_id=general`,
    );
    const rows = summary.data.latest_progress.safe_progress_rows as Array<{
      safe_label: string;
      state: string;
    }>;
    const projectLedgerRows = rows.filter(
      (row) => row.safe_label === "Checking Project Ledger status",
    );

    expect(projectLedgerRows).toHaveLength(2);
    expect(projectLedgerRows.map((row) => row.state).sort()).toEqual([
      "delivered",
      "delivered",
    ]);
  } finally {
    server.stop();
  }
});

test("session summary keeps same-label progress rows separate when path evidence conflicts", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
    responder(input) {
      input.onProgress?.({
        id: "file-write-a",
        kind: "edited",
        state: "delivered",
        safe_label: "Writing project file",
        safe_tool_name: "File",
        safe_input_label: "write",
        tool_call_id: "tool-write-a",
        safe_path_labels: ["~/project-a/game.js"],
      });
      input.onProgress?.({
        id: "file-write-b",
        kind: "edited",
        state: "running",
        safe_label: "Writing project file",
        safe_tool_name: "File",
        safe_input_label: "write",
        safe_path_labels: ["~/project-b/game.js"],
      });
      return { texts: ["done"] };
    },
  });
  try {
    await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "write files",
    });

    const summary = await getJson(
      `${server.url}session-summary?session_id=general`,
    );
    const rows = summary.data.latest_progress.safe_progress_rows as Array<{
      safe_label: string;
      state: string;
    }>;
    const fileRows = rows.filter(
      (row) => row.safe_label === "Writing project file",
    );

    expect(fileRows).toHaveLength(2);
    expect(fileRows.map((row) => row.state).sort()).toEqual([
      "delivered",
      "delivered",
    ]);
  } finally {
    server.stop();
  }
});

test("session summary keeps terminal progress state when a later running row arrives", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
    responder(input) {
      input.onProgress?.({
        id: "tool-complete",
        kind: "ran_command",
        state: "complete",
        safe_label: "Bash: bun test",
        safe_tool_name: "Bash",
        safe_input_label: "bun test",
        tool_call_id: "tool-test",
      });
      input.onProgress?.({
        id: "tool-running-late",
        kind: "ran_command",
        state: "running",
        safe_label: "Bash: bun test",
        safe_tool_name: "Bash",
        safe_input_label: "bun test",
        tool_call_id: "tool-test",
      });
      return { texts: ["done"] };
    },
  });
  try {
    await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "run tests",
    });

    const summary = await getJson(
      `${server.url}session-summary?session_id=general`,
    );
    expect(summary.data.latest_progress.safe_progress_rows).toContainEqual(
      expect.objectContaining({
        safe_label: "Bash: bun test",
        state: "complete",
        tool_call_id: "tool-test",
      }),
    );
  } finally {
    server.stop();
  }
});

test("session summary keeps repeated identical tool calls separate", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
    responder(input) {
      for (const toolCallId of ["tool-repeat-1", "tool-repeat-2"]) {
        input.onTurnEvent?.({
          kind: "tool.completed",
          payload: {
            toolCallId,
            activityKind: "ran_command",
            toolName: "Bash",
            inputLabel: "ls",
            safeLabel: "Bash: ls",
          },
        });
      }
      return { texts: ["done"] };
    },
  });
  try {
    await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "repeat",
    });
    const summary = await getJson(
      `${server.url}session-summary?session_id=general`,
    );
    const repeated = (
      summary.data.latest_progress.safe_progress_rows as Array<{
        safe_label: string;
        tool_call_id?: string;
      }>
    ).filter((row) => row.safe_label === "Bash: ls");

    expect(repeated.map((row) => row.tool_call_id).sort()).toEqual([
      "tool-repeat-1",
      "tool-repeat-2",
    ]);
  } finally {
    server.stop();
  }
});

test("hung responders stay admitted without gateway timeout cancellation", async () => {
  let aborted = false;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
    responderTimeoutMs: 25,
    responder(input) {
      markStarted?.();
      return new Promise((_, reject) => {
        input.signal?.addEventListener("abort", () => {
          aborted = true;
          const error = new Error("cancelled");
          error.name = "AppResponderCancelledError";
          reject(error);
        });
      });
    },
  });
  try {
    const startedAt = Date.now();
    const response = await fetch(`${server.url}messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: "general",
        text: "please do not hang forever",
      }),
    });
    const body = await response.json();
    expect(Date.now() - startedAt).toBeLessThan(1000);
    await started;
    expect(response.status).toBe(202);
    expect(body.protocol_version).toBe("butler.app.v1");
    expect(body.data.turn).toMatchObject({
      state: "thinking",
      cancellable: true,
      retryable: false,
    });
    expect(body.data.replies).toEqual([]);
    expect(aborted).toBe(false);
    expect(JSON.stringify(body)).not.toContain(tempDir);
    expect(JSON.stringify(body)).not.toContain("sqlite");

    const messages = await getJson(
      `${server.url}messages?chat_id=general&cursor=0`,
    );
    expect(
      messages.data.messages.map((message: { text: string }) => message.text),
    ).toContain("please do not hang forever");
    const failed = messages.data.messages.find(
      (message: { status: string }) => message.status === "failed",
    );
    expect(failed).toBeUndefined();

    const turns = await getJson(`${server.url}turns?chat_id=general&cursor=0`);
    expect(turns.data.turns[0]).toMatchObject({
      state: "thinking",
      retryable: false,
      cancellable: true,
    });
    expect(turns.data.turns[0].safe_error_code ?? null).toBeNull();
  } finally {
    server.stop();
  }
});

test("turn cancel aborts in-flight responder without creating a failure reply", async () => {
  let markStarted: (() => void) | undefined;
  let aborted = false;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
    responder(input) {
      input.onProgress?.({
        id: "cancel-progress-row",
        kind: "ran_command",
        state: "running",
        safe_label: "Bash: npm test",
        safe_tool_name: "Bash",
        safe_input_label: "npm test",
        work_block_id: "cancel-work",
        work_block_label: "중단 전 실행한 검증",
      });
      markStarted?.();
      input.signal?.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise(() => undefined);
    },
  });
  try {
    const pendingSend = fetch(`${server.url}messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: "general", text: "stop this turn" }),
    });
    await started;
    const turns = await getJson(`${server.url}turns?chat_id=general&cursor=0`);
    const turnId = turns.data.turns[0].id;

    const cancel = await postJson(
      `${server.url}turns/${encodeURIComponent(turnId)}/cancel`,
      {},
    );
    expect(cancel.data.turn).toMatchObject({
      state: "cancelled",
      retryable: false,
      cancellable: false,
    });

    const response = await pendingSend;
    const body = await response.json();
    expect(response.status).toBe(202);
    expect(body.data.turn).toMatchObject({
      state: "thinking",
      retryable: false,
      cancellable: true,
    });
    expect(body.data.replies).toEqual([]);
    expect(aborted).toBe(true);

    const finalTurns = await getJson(
      `${server.url}turns?chat_id=general&cursor=0`,
    );
    expect(finalTurns.data.turns[0]).toMatchObject({
      state: "cancelled",
      retryable: false,
      cancellable: false,
    });

    const messages = await getJson(
      `${server.url}messages?chat_id=general&cursor=0`,
    );
    expect(messages.data.messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        status: "cancelled",
        text: "Stopped.",
        turn_id: turnId,
        work_blocks: [
          expect.objectContaining({
            id: "cancel-work",
            label: "중단 전 실행한 검증",
            state: "cancelled",
            rows: [
              expect.objectContaining({
                id: "cancel-progress-row",
                state: "cancelled",
                safe_tool_name: "Bash",
              }),
            ],
          }),
        ],
      }),
    );
    const events = await getJson(`${server.url}events?cursor=0`);
    expect(events.data.events).toContainEqual(
      expect.objectContaining({
        type: "message.created",
        payload: expect.objectContaining({
          message: expect.objectContaining({
            role: "assistant",
            status: "cancelled",
            turn_id: turnId,
            work_blocks: [
              expect.objectContaining({
                id: "cancel-work",
                state: "cancelled",
              }),
            ],
          }),
        }),
      }),
    );
    expect(JSON.stringify(messages)).not.toContain("could not verify");
  } finally {
    server.stop();
  }
});

test("turn cancel preserves earlier assistant work history while stopping active turn", async () => {
  let turnCount = 0;
  let markSecondStarted: (() => void) | undefined;
  const secondStarted = new Promise<void>((resolve) => {
    markSecondStarted = resolve;
  });
  let aborted = false;
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
    responder(input) {
      turnCount += 1;
      if (turnCount === 1) {
        input.onProgress?.({
          id: "first-progress-row",
          kind: "ran_command",
          state: "delivered",
          safe_label: "Bash: echo baseline",
          safe_tool_name: "Bash",
          safe_input_label: "echo baseline",
          work_block_id: "legacy-work",
          work_block_label: "기본 작업",
        });
        return { texts: ["기본 작업은 완료했습니다."] };
      }
      input.onProgress?.({
        id: "cancel-progress-row",
        kind: "ran_command",
        state: "running",
        safe_label: "Bash: npm test",
        safe_tool_name: "Bash",
        safe_input_label: "npm test",
        work_block_id: "cancel-work",
        work_block_label: "중단할 작업",
      });
      markSecondStarted?.();
      input.signal?.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise(() => undefined);
    },
  });

  try {
    const first = await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "run baseline",
    });
    await waitForAssistantMessageMatching(
      server.url,
      "general",
      (message) => message.text === "기본 작업은 완료했습니다.",
    );

    const inFlight = fetch(`${server.url}messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: "general", text: "stop this new turn" }),
    });
    await secondStarted;

    let secondTurnId: string | undefined;
    for (let attempt = 0; attempt < 30 && !secondTurnId; attempt += 1) {
      const turns = await getJson(
        `${server.url}turns?chat_id=general&cursor=0`,
      );
      secondTurnId = turns.data.turns.find(
        (turn: { id: string }) => turn.id !== first.data.turn.id,
      )?.id;
      if (!secondTurnId) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    expect(secondTurnId).toBeDefined();
    const cancel = await postJson(
      `${server.url}turns/${encodeURIComponent(secondTurnId)}/cancel`,
      {},
    );
    expect(cancel.data.turn).toMatchObject({
      id: secondTurnId,
      state: "cancelled",
      retryable: false,
      cancellable: false,
    });

    const completedRequest = await inFlight;
    expect(completedRequest.status).toBe(202);
    expect(aborted).toBe(true);

    const messages = await getJson(
      `${server.url}messages?chat_id=general&cursor=0`,
    );
    const assistantMessages = messages.data.messages.filter(
      (message: { role: string }) => message.role === "assistant",
    );
    expect(assistantMessages).toHaveLength(2);
    expect(
      assistantMessages.find(
        (message: { text: string }) => message.text === "기본 작업은 완료했습니다.",
      ),
    ).toMatchObject({
      status: "delivered",
      turn_id: first.data.turn.id,
      work_blocks: [
        expect.objectContaining({
          id: "legacy-work",
          label: "기본 작업",
          state: "delivered",
          rows: [
            expect.objectContaining({
              id: "first-progress-row",
              state: "delivered",
            }),
          ],
        }),
      ],
    });
    expect(
      assistantMessages.find(
        (message: { status: string }) => message.status === "cancelled",
      ),
    ).toMatchObject({
      turn_id: secondTurnId,
      text: "Stopped.",
      status: "cancelled",
      work_blocks: [
        expect.objectContaining({
          id: "cancel-work",
          label: "중단할 작업",
          state: "cancelled",
          rows: [expect.objectContaining({ id: "cancel-progress-row", state: "cancelled" })],
        }),
      ],
    });
    expect(JSON.stringify(messages)).not.toContain("Retrying this turn");
  } finally {
    server.stop();
  }
});

test("app startup repairs cancelled turns that lost their activity carrier", async () => {
  const dbPath = join(tempDir, "app.sqlite");
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let server = createAppServer({
    dbPath,
    port: 0,
    responder(input) {
      input.onProgress?.({
        id: "legacy-cancel-progress-row",
        kind: "ran_command",
        state: "running",
        safe_label: "Bash: bun test",
        safe_tool_name: "Bash",
        safe_input_label: "bun test",
        work_block_id: "legacy-cancel-work",
        work_block_label: "중단 전에 남아 있던 작업",
      });
      markStarted?.();
      return new Promise(() => undefined);
    },
  });

  try {
    await fetch(`${server.url}messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: "general", text: "stop legacy turn" }),
    });
    await started;
    const turns = await getJson(`${server.url}turns?chat_id=general&cursor=0`);
    const turnId = turns.data.turns[0].id;
    await postJson(`${server.url}turns/${encodeURIComponent(turnId)}/cancel`, {});
    server.stop();

    const db = new Database(dbPath);
    try {
      db.query("DELETE FROM messages WHERE turn_id = ? AND role = 'assistant'")
        .run(turnId);
      db.query(`
        INSERT INTO messages (
          id, chat_id, turn_id, role, text, status, created_at, updated_at,
          safe_error_code, retryable
        )
        VALUES (?, ?, ?, 'assistant', 'Retrying this turn.', 'retrying', ?, ?, NULL, 0)
      `).run(
        "msg-legacy-stale-cancel-carrier",
        "general",
        turnId,
        "2026-06-28T00:00:00.000Z",
        "2026-06-28T00:00:00.000Z",
      );
      db.query("DELETE FROM events WHERE type = 'message.created' AND payload_json LIKE ?")
        .run(`%${turnId}%`);
      const internalEventId = "turn-event-legacy-continuation";
      const createdAt = "2026-06-28T00:00:00.000Z";
      db.query("INSERT INTO events (type, payload_json, created_at) VALUES (?, ?, ?)")
        .run("agent.turn_event", JSON.stringify({
          session_id: "general",
          turn_id: turnId,
          event: {
            id: internalEventId,
            sessionId: "general",
            turnId,
            createdAt,
            kind: "tool.progress",
            visibility: "public",
            payload: {
              activityKind: "model",
              state: "running",
              safeLabel: "Continuing current turn",
              delivery_state: "needs_evidence",
              noVisibleReply: true,
              continuation_requeued: true,
            },
          },
        }), createdAt);
      db.query("INSERT INTO events (type, payload_json, created_at) VALUES (?, ?, ?)")
        .run("agent.turn_event.progress", JSON.stringify({
          session_id: "general",
          turn_id: turnId,
          event_id: internalEventId,
          row: {
            id: internalEventId,
            kind: "model",
            safe_label: "Continuing current turn",
            state: "running",
            created_at: createdAt,
            safe_tool_name: "Tool",
            work_block_label: "Continuing current turn",
          },
        }), createdAt);
    } finally {
      db.close();
    }

    server = createAppServer({ dbPath, butlerData: tempDir, port: 0 });
    const messages = await getJson(`${server.url}messages?chat_id=general`);
    expect(messages.data.messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        status: "cancelled",
        text: "Stopped.",
        turn_id: turnId,
        work_blocks: [
          expect.objectContaining({
            id: "legacy-cancel-work",
            label: "중단 전에 남아 있던 작업",
            state: "cancelled",
            rows: [
              expect.objectContaining({
                id: "legacy-cancel-progress-row",
                state: "cancelled",
                safe_tool_name: "Bash",
              }),
            ],
          }),
        ],
      }),
    );
    expect(JSON.stringify(messages)).not.toContain("Continuing current turn");
  } finally {
    server.stop();
  }
});

test("failed app turns persist as retryable and can be retried", async () => {
  let attempt = 0;
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
    responder() {
      attempt += 1;
      if (attempt === 1)
        throw new Error("private provider stack should not leak");
      return { texts: ["recovered reply"] };
    },
  });
  try {
    const failedResponse = await fetch(`${server.url}messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: "general", text: "please retry this" }),
    });
    const failedBody = await failedResponse.json();
    expect(failedResponse.status).toBe(202);
    expect(failedBody.data.turn.state).toBe("thinking");
    expect(JSON.stringify(failedBody)).not.toContain("private provider stack");

    const failedTurn = await waitForLatestTurnMatching(
      server.url,
      "general",
      (turn) => turn.state === "failed",
    );
    expect(failedTurn).toMatchObject({
      state: "failed",
      safe_error_code: "gateway_failed",
      retryable: true,
      attempt: 1,
    });

    const failedTurnId = failedTurn.id as string;
    const retry = await postJson(
      `${server.url}turns/${encodeURIComponent(failedTurnId)}/retry`,
      {},
    );
    expect(retry.data.turn).toMatchObject({
      state: "retrying",
      retryable: false,
      cancellable: true,
      attempt: 2,
    });
    const reply = await waitForAssistantMessageMatching(
      server.url,
      "general",
      (message) => message.text === "recovered reply",
    );
    expect(reply.text).toBe("recovered reply");

    const messages = await getJson(
      `${server.url}messages?chat_id=general&cursor=0`,
    );
    expect(
      messages.data.messages.map(
        (message: { status: string }) => message.status,
      ),
    ).toEqual(["sent", "delivered"]);
    expect(
      messages.data.messages.filter(
        (message: { role: string }) => message.role === "assistant",
      ),
    ).toHaveLength(1);
  } finally {
    server.stop();
  }
});

test("retrying a failed turn updates the same logical turn without synthetic retry text", async () => {
  let attempt = 0;
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
    responder() {
      attempt += 1;
      if (attempt === 1) throw new Error("provider temporary issue");
      return { texts: ["recovered reply"] };
    },
  });
  try {
    const response = await fetch(`${server.url}messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: "general",
        text: "retry this failed app turn",
      }),
    });
    expect(response.status).toBe(202);

    const failedTurn = await waitForLatestTurnMatching(
      server.url,
      "general",
      (turn) => turn.state === "failed" && turn.retryable,
    );
    const failedTurnId = failedTurn.id as string;

    const retry = await postJson(
      `${server.url}turns/${encodeURIComponent(failedTurnId)}/retry`,
      {},
    );
    expect(retry.data.turn).toMatchObject({
      state: "retrying",
      retryable: false,
      cancellable: true,
      attempt: 2,
    });
    await waitForAssistantMessageMatching(
      server.url,
      "general",
      (message) => message.text === "recovered reply",
    );

    const messages = await getJson(
      `${server.url}messages?chat_id=general&cursor=0`,
    );
    expect(
      messages.data.messages.filter(
        (message: { role: string }) => message.role === "assistant",
      ),
    ).toHaveLength(1);
    expect(messages.data.messages).not.toContainEqual(
      expect.objectContaining({
        role: "assistant",
        text: "Retrying this turn.",
      }),
    );
    expect(JSON.stringify(messages)).not.toContain("Retrying this turn.");
  } finally {
    server.stop();
  }
});

test("retry failures update the same assistant failure with a safe provider reason", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
    responder() {
      throw new Error("Local model API returned no text output");
    },
  });
  try {
    const failedResponse = await fetch(`${server.url}messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: "general",
        text: "please retry local model",
      }),
    });
    expect(failedResponse.status).toBe(202);

    const failedTurn = await waitForLatestTurnMatching(
      server.url,
      "general",
      (turn) => turn.state === "failed",
    );
    expect(failedTurn).toMatchObject({
      state: "failed",
      safe_error_code: "provider_empty_response",
      retryable: true,
    });

    let messages = await getJson(
      `${server.url}messages?chat_id=general&cursor=0`,
    );
    const firstAssistant = messages.data.messages.find(
      (message: { role: string }) => message.role === "assistant",
    );
    expect(firstAssistant).toMatchObject({
      status: "failed",
      safe_error_code: "provider_empty_response",
      retryable: true,
    });
    expect(firstAssistant.text).toContain("no visible answer");
    expect(firstAssistant.text).not.toContain("Local model API");

    const failedTurnId = failedTurn.id as string;
    const retryResponse = await fetch(
      `${server.url}turns/${encodeURIComponent(failedTurnId)}/retry`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(retryResponse.status).toBe(202);
    await waitForLatestTurnMatching(
      server.url,
      "general",
      (turn) =>
        turn.state === "failed" &&
        turn.attempt === 2 &&
        turn.safe_error_code === "provider_empty_response",
    );

    messages = await getJson(`${server.url}messages?chat_id=general&cursor=0`);
    const assistantMessages = messages.data.messages.filter(
      (message: { role: string }) => message.role === "assistant",
    );
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]).toMatchObject({
      status: "failed",
      safe_error_code: "provider_empty_response",
      retryable: true,
    });
    expect(assistantMessages[0].id).not.toBe(firstAssistant.id);
    expect(assistantMessages[0].text).toContain("no visible answer");
    expect(JSON.stringify(messages)).not.toContain("Retrying this turn");
  } finally {
    server.stop();
  }
});

test("provider failures persist actionable safe API status", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
    responder() {
      throw new ModelProviderRequestError({
        code: "provider_api_error",
        message: "OpenAI API request failed with HTTP 500.",
        provider: "openai",
        api: "responses",
        statusCode: 500,
        endpoint: "https://api.openai.com/v1/responses",
        model: "gpt-5.5",
        retryable: true,
        cause: "private upstream stack token=secret",
      });
    },
  });
  try {
    const failedResponse = await fetch(`${server.url}messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: "general",
        text: "please surface provider status",
      }),
    });
    expect(failedResponse.status).toBe(202);

    const failedTurn = await waitForLatestTurnMatching(
      server.url,
      "general",
      (turn) => turn.state === "failed",
    );
    expect(failedTurn).toMatchObject({
      state: "failed",
      safe_error_code: "provider_api_error",
      retryable: true,
      cancellable: false,
    });

    const messages = await getJson(
      `${server.url}messages?chat_id=general&cursor=0`,
    );
    const assistant = messages.data.messages.find(
      (message: { role: string }) => message.role === "assistant",
    );
    expect(assistant).toMatchObject({
      status: "failed",
      safe_error_code: "provider_api_error",
      retryable: true,
    });
    expect(assistant.text).toContain("HTTP 500");
    expect(JSON.stringify(messages)).not.toContain("token=secret");
    expect(JSON.stringify(messages)).not.toContain("private upstream stack");

    const events = await getJson(`${server.url}events?cursor=0`);
    const failedEvent = events.data.events.find(
      (
        event: {
          type: string;
          payload?: { event?: { kind?: string; payload?: unknown } };
        },
      ) =>
        event.type === "agent.turn_event" &&
        event.payload?.event?.kind === "turn.failed",
    );
    expect(failedEvent?.payload?.event?.payload).toMatchObject({
      safeErrorCode: "provider_api_error",
      safeCause: "private upstream stack [redacted]",
    });
    expect(JSON.stringify(events)).not.toContain("token=secret");
  } finally {
    server.stop();
  }
});

test("raw provider aborts remain failed app turns instead of cancellation", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
    responder() {
      const error = new Error("Provider request aborted by remote connection reset.");
      error.name = "AbortError";
      (error as Error & { code?: string }).code = "ABORT_ERR";
      throw error;
    },
  });
  try {
    const failedResponse = await fetch(`${server.url}messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: "general",
        text: "please keep provider abort visible",
      }),
    });
    expect(failedResponse.status).toBe(202);

    const failedTurn = await waitForLatestTurnMatching(
      server.url,
      "general",
      (turn) => turn.state === "failed",
    );
    expect(failedTurn).toMatchObject({
      state: "failed",
      safe_error_code: "provider_network_error",
      retryable: true,
      cancellable: false,
    });

    const messages = await getJson(
      `${server.url}messages?chat_id=general&cursor=0`,
    );
    const assistant = messages.data.messages.find(
      (message: { role: string }) => message.role === "assistant",
    );
    expect(assistant).toMatchObject({
      status: "failed",
      safe_error_code: "provider_network_error",
      retryable: true,
    });
    expect(messages.data.messages.map((message: { status: string }) => message.status))
      .toEqual(["sent", "failed"]);
  } finally {
    server.stop();
  }
});

test("goal completion incomplete gaps keep turns active instead of app failures", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
    responder() {
      const error = new Error(
        "확인 가능한 공개 출처를 읽지 못했습니다. token=secret",
      );
      error.name = "GoalCompletionIncompleteError";
      throw error;
    },
  });
  try {
    const response = await fetch(`${server.url}messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: "general",
        text: "complete this only with verified evidence",
      }),
    });
    expect(response.status).toBe(202);

    const recoveringTurn = await waitForLatestTurnMatching(
      server.url,
      "general",
      (turn) => turn.state === "retrying",
    );
    expect(recoveringTurn).toMatchObject({
      state: "retrying",
      safe_status_label: "",
      retryable: false,
      cancellable: true,
    });
    expect(recoveringTurn.safe_error_code ?? null).toBeNull();

    const messages = await getJson(`${server.url}messages?chat_id=general`);
    expect(
      messages.data.messages.filter(
        (message: { role: string }) => message.role === "assistant",
      ),
    ).toEqual([]);
    expect(JSON.stringify(messages)).not.toContain("token=secret");
  } finally {
    server.stop();
  }
});

test("goal completion obligation protocol gaps stay active without generic assistant text", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
    responder() {
      const error = new Error(
        "The turn still needs repair for missing public completion obligation(s): durable_artifact, data_table_created.",
      );
      error.name = "GoalCompletionIncompleteError";
      throw error;
    },
  });
  try {
    const response = await fetch(`${server.url}messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: "general",
        text: "create a csv and report",
      }),
    });
    expect(response.status).toBe(202);

    const recoveringTurn = await waitForLatestTurnMatching(
      server.url,
      "general",
      (turn) => turn.state === "retrying",
    );
    expect(recoveringTurn).toMatchObject({
      state: "retrying",
      safe_status_label: "",
      retryable: false,
      cancellable: true,
    });
    expect(recoveringTurn.safe_error_code ?? null).toBeNull();
    const messages = await getJson(`${server.url}messages?chat_id=general`);
    expect(
      messages.data.messages.filter(
        (message: { role: string }) => message.role === "assistant",
      ),
    ).toEqual([]);
    expect(JSON.stringify(messages)).not.toContain("진행한 내용은 보존했습니다");
    expect(JSON.stringify(messages)).not.toContain("could not verify");
    expect(JSON.stringify(messages)).not.toContain("durable_artifact");
    expect(JSON.stringify(messages)).not.toContain("data_table_created");
  } finally {
    server.stop();
  }
});

test("generic internal recovery responder failures stay active without assistant text", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
    responder() {
      const error = new Error(
        "Butler could not verify that the requested goal was completed.",
      );
      (error as Error & { code?: string }).code = "internal_recovery_required";
      throw error;
    },
  });
  try {
    const response = await fetch(`${server.url}messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: "general",
        text: "continue the latest work",
      }),
    });
    expect(response.status).toBe(202);

    const recoveringTurn = await waitForLatestTurnMatching(
      server.url,
      "general",
      (turn) => turn.state === "retrying",
    );
    expect(recoveringTurn).toMatchObject({
      state: "retrying",
      safe_status_label: "",
      retryable: false,
      cancellable: true,
    });
    expect(recoveringTurn.safe_error_code ?? null).toBeNull();

    const messages = await getJson(`${server.url}messages?chat_id=general`);
    expect(
      messages.data.messages.filter(
        (message: { role: string }) => message.role === "assistant",
      ),
    ).toEqual([]);
    expect(JSON.stringify(messages)).not.toContain("could not verify");

    const events = await getJson(`${server.url}events?cursor=0`);
    expect(JSON.stringify(events)).not.toContain("turn.failed");
    expect(JSON.stringify(events)).not.toContain("could not verify");
  } finally {
    server.stop();
  }
});

test("concurrent retry claims only one failed turn attempt", async () => {
  let attempt = 0;
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
    async responder() {
      attempt += 1;
      if (attempt === 1) throw new Error("first attempt fails");
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { texts: [`retry attempt ${attempt}`] };
    },
  });
  try {
    await fetch(`${server.url}messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: "general", text: "retry once only" }),
    });
    const failedTurn = await waitForLatestTurnMatching(
      server.url,
      "general",
      (turn) => turn.state === "failed",
    );
    const turnId = failedTurn.id as string;

    const [first, second] = await Promise.all([
      fetch(`${server.url}turns/${encodeURIComponent(turnId)}/retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
      fetch(`${server.url}turns/${encodeURIComponent(turnId)}/retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([202, 409]);

    const finalTurn = await waitForLatestTurnMatching(
      server.url,
      "general",
      (turn) => turn.state === "delivered",
    );
    expect(finalTurn).toMatchObject({
      state: "delivered",
      attempt: 2,
    });
  } finally {
    server.stop();
  }
});

test("turn cancel endpoint returns safe conflict for completed turns", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
    responder(input) {
      return { texts: [`done: ${input.text}`] };
    },
  });
  try {
    const result = await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "already done",
    });
    const response = await fetch(
      `${server.url}turns/${encodeURIComponent(result.data.turn.id)}/cancel`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    const body = await response.json();
    expect(response.status).toBe(409);
    expect(body.error.code).toBe("turn_not_cancellable");
    expect(JSON.stringify(body)).not.toContain(tempDir);
  } finally {
    server.stop();
  }
});

test("event replay is idempotent and includes message, turn, and progress events", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
    responder: (input) => {
      input.onProgress?.({
        id: "progress-command",
        kind: "ran_command",
        safe_label: "Bash: bun test",
        safe_tool_name: "Bash",
        safe_input_label: "bun test",
        state: "running",
        safe_detail_rows: [
          {
            id: "progress-command-detail",
            kind: "command",
            safe_label: "Command",
            safe_value: "bun test",
            state: "running",
          },
        ],
      });
      return { texts: ["done"] };
    },
  });
  try {
    await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "eventful",
    });
    const first = await getJson(`${server.url}events?cursor=0`);
    const second = await getJson(`${server.url}events?cursor=0`);
    expect(second.data).toEqual(first.data);
    expect(
      first.data.events.map((event: { type: string }) => event.type),
    ).toContain("message.created");
    expect(
      first.data.events.map((event: { type: string }) => event.type),
    ).toContain("turn.state_changed");
    expect(
      first.data.events.map((event: { type: string }) => event.type),
    ).toContain("progress.summary");
    expect(JSON.stringify(first.data.events)).not.toContain(tempDir);
    const summary = await getJson(
      `${server.url}session-summary?session_id=general`,
    );
    expect(summary.data.latest_progress.safe_progress_rows).toContainEqual(
      expect.objectContaining({
        kind: "ran_command",
        safe_tool_name: "Bash",
        safe_input_label: "bun test",
      }),
    );
    expect(first.data.next_cursor).toBe(first.data.events.at(-1).id);
  } finally {
    server.stop();
  }
});

test("gateway bridge keeps runtime turns alive past request timeout budgets", async () => {
  const runtime = new HangingRuntime();
  const bridge = new AppGatewayBridge({
    butlerHome: tempDir,
    butlerData: tempDir,
    runtime,
    provider: fakeProvider,
  });
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
    responder: bridge.responder,
    responderTimeoutMs: 25,
  });
  try {
    const response = await fetch(`${server.url}messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: "general",
        text: "hang through gateway",
      }),
    });
    const body = await response.json();
    expect(response.status).toBe(202);
    expect(body.data.turn).toMatchObject({
      state: "thinking",
      cancellable: true,
    });
    expect(runtime.sawSignal).toBe(true);
    expect(runtime.aborted).toBe(false);
  } finally {
    server.stop();
    bridge.close();
  }
});

test("message endpoint rate limits bursts with safe protocol errors", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
    messageRateLimit: {
      max: 1,
      windowMs: 1000,
    },
  });
  try {
    await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "first message",
    });
    const otherChat = await postJson(`${server.url}sessions`, {
      kind: "chat",
      title: "Rate limit bypass session",
    });
    await postJson(`${server.url}messages`, {
      chat_id: otherChat.data.session.id,
      text: "different chat can still send",
    });
    const response = await fetch(`${server.url}messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: "general", text: "second message" }),
    });
    const body = await response.json();
    expect(response.status).toBe(429);
    expect(body.protocol_version).toBe("butler.app.v1");
    expect(body.error.code).toBe("rate_limited");
    expect(JSON.stringify(body)).not.toContain(tempDir);
    expect(JSON.stringify(body)).not.toContain("sqlite");
  } finally {
    server.stop();
  }
});

test("static UI responses include strict security headers", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
  });
  try {
    const response = await fetch(server.url);
    expect(response.ok).toBe(true);
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'self'",
    );
    expect(response.headers.get("content-security-policy")).toContain(
      "object-src 'none'",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  } finally {
    server.stop();
  }
});

test("app server allows only configured local Vite dev origin for HMR mode", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
    devCorsOrigin: "http://127.0.0.1:5173",
  });
  try {
    const preflight = await fetch(`${server.url}messages`, {
      method: "OPTIONS",
      headers: {
        origin: "http://127.0.0.1:5173",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      "http://127.0.0.1:5173",
    );
    expect(preflight.headers.get("access-control-allow-methods")).toContain(
      "POST",
    );

    const health = await fetch(`${server.url}health`, {
      headers: { origin: "http://127.0.0.1:5173" },
    });
    expect(health.headers.get("access-control-allow-origin")).toBe(
      "http://127.0.0.1:5173",
    );

    const rejected = await fetch(`${server.url}health`, {
      headers: { origin: "http://evil.localhost:5173" },
    });
    expect(rejected.headers.get("access-control-allow-origin")).toBe(null);
  } finally {
    server.stop();
  }
});

test("app server allows local Vite dev origins by default", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
  });
  try {
    const health = await fetch(`${server.url}health`, {
      headers: { origin: "http://127.0.0.1:5173" },
    });
    expect(health.headers.get("access-control-allow-origin")).toBe(
      "http://127.0.0.1:5173",
    );

    const alternateVitePort = await fetch(`${server.url}health`, {
      headers: { origin: "http://127.0.0.1:5174" },
    });
    expect(alternateVitePort.headers.get("access-control-allow-origin")).toBe(
      "http://127.0.0.1:5174",
    );

    const rejected = await fetch(`${server.url}health`, {
      headers: { origin: "http://evil.localhost:5173" },
    });
    expect(rejected.headers.get("access-control-allow-origin")).toBe(null);
  } finally {
    server.stop();
  }
});

test("server close checkpoints WAL and preserves chat store", async () => {
  const dbPath = join(tempDir, "app.sqlite");
  let server = createAppServer({ dbPath, port: 0 });
  await postJson(`${server.url}messages`, {
    chat_id: "general",
    text: "checkpoint this",
  });
  server.stop();

  const walPath = `${dbPath}-wal`;
  if (existsSync(walPath)) {
    expect(statSync(walPath).size).toBe(0);
  }

  server = createAppServer({ dbPath, port: 0 });
  try {
    const messages = await getJson(
      `${server.url}messages?chat_id=general&cursor=0`,
    );
    expect(
      messages.data.messages.map((message: { text: string }) => message.text),
    ).toContain("checkpoint this");
  } finally {
    server.stop();
  }
});

test("invalid messages return protocol error without raw server state", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
  });
  try {
    const response = await fetch(`${server.url}messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "" }),
    });
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.protocol_version).toBe("butler.app.v1");
    expect(body.error.code).toBe("invalid_request");
    expect(JSON.stringify(body)).not.toContain("sqlite");
  } finally {
    server.stop();
  }
});

test("static UI serving blocks path traversal", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
  });
  try {
    const response = await fetch(`${server.url}..%2Fpackage.json`);
    const body = await response.json();
    expect(response.status).toBe(404);
    expect(body.error.code).toBe("not_found");
  } finally {
    server.stop();
  }
});

function writeOnboardingStateForTest(
  butlerData: string,
  status: "pending" | "complete",
): void {
  const onboardingDir = join(butlerData, "personalization");
  mkdirSync(onboardingDir, { recursive: true });
  writeFileSync(
    join(onboardingDir, "onboarding.json"),
    `${JSON.stringify({
      schema: "butler.first_chat_onboarding.v1",
      status,
      gateway: "any",
      fields: {},
      skipped_fields: [],
      created_at: "2026-05-28T00:00:00.000Z",
      updated_at: "2026-05-28T00:00:00.000Z",
      completed_at: status === "complete" ? "2026-05-28T00:00:00.000Z" : null,
    }, null, 2)}\n`,
    "utf8",
  );
}

async function createExistingFolderProjectForTest(
  serverUrl: string,
  folderPath: string,
  folderSelectionSecret: string,
  displayName: string,
): Promise<{ id: string; display_name: string }> {
  const token = createProjectFolderSelectionToken(
    folderPath,
    folderSelectionSecret,
  );
  const created = await postJson(`${serverUrl}projects`, {
    source: "existing_folder",
    display_name: displayName,
    folder_selection_token: token,
  });
  return created.data.project;
}

async function getJson(url: string) {
  const response = await fetch(url);
  expect(response.ok).toBe(true);
  return await response.json();
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Condition did not become true.");
}

async function waitForHttpOk(url: string): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}: ${String(lastError)}`);
}

async function waitForHttpStatus(url: string, status: number): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.status === status) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}: ${String(lastError)}`);
}

async function findAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : null;
      probe.close(() => {
        if (port === null) reject(new Error("Could not allocate test port."));
        else resolve(port);
      });
    });
  });
}

async function terminateChild(proc: ReturnType<typeof spawn>): Promise<void> {
  if (proc.exitCode !== null) return;
  const exited = new Promise((resolve) => proc.once("exit", resolve));
  proc.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, 500)),
  ]);
  if (proc.exitCode === null) proc.kill("SIGKILL");
}

async function readSseEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (event: {
    id?: number;
    type?: string;
    payload?: Record<string, unknown>;
  }) => boolean,
) {
  const decoder = new TextDecoder();
  let buffer = "";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) =>
        setTimeout(
          () => reject(new Error("Timed out waiting for SSE event.")),
          500,
        ),
      ),
    ]);
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const dataLine = block
        .split("\n")
        .find((line) => line.startsWith("data: "));
      if (!dataLine) continue;
      const event = JSON.parse(dataLine.slice("data: ".length)) as {
        id?: number;
        type?: string;
        payload?: Record<string, unknown>;
      };
      if (predicate(event)) return event;
    }
  }
  throw new Error("Expected SSE event did not arrive.");
}

async function postJson(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.ok).toBe(true);
  return await response.json();
}

async function patchJson(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.ok).toBe(true);
  return await response.json();
}

async function deleteJson(url: string) {
  const response = await fetch(url, { method: "DELETE" });
  expect(response.ok).toBe(true);
  return await response.json();
}

async function waitForAutomationRun(url: string, automationId: string) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const runs = await getJson(
      `${url}automations/${encodeURIComponent(automationId)}/runs`,
    );
    if (runs.data.runs.length > 0) return runs;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Automation run did not appear.");
}

async function waitForTurnState(url: string, chatId: string, state: string) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const turns = await getJson(
      `${url}turns?chat_id=${encodeURIComponent(chatId)}`,
    );
    if (
      turns.data.turns.some((turn: { state: string }) => turn.state === state)
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Turn state did not appear: ${state}`);
}

async function waitForLatestTurnMatching(
  url: string,
  chatId: string,
  predicate: (turn: Record<string, unknown>) => boolean,
) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const turns = await getJson(
      `${url}turns?chat_id=${encodeURIComponent(chatId)}&cursor=0`,
    );
    const turn = turns.data.turns[0] as Record<string, unknown> | undefined;
    if (turn && predicate(turn)) return turn;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Expected turn projection did not appear.");
}

async function waitForAssistantMessageMatching(
  url: string,
  chatId: string,
  predicate: (message: Record<string, unknown>) => boolean,
) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const messages = await getJson(
      `${url}messages?chat_id=${encodeURIComponent(chatId)}&cursor=0`,
    );
    const assistant = (
      messages.data.messages as Array<Record<string, unknown>>
    ).find((message) => message.role === "assistant" && predicate(message));
    if (assistant) return assistant;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Expected assistant message projection did not appear.");
}

class ScriptedRuntime implements AgentRuntimeAdapter {
  readonly id = "app-test-runtime";
  readonly turns: RuntimeTurnInput[] = [];
  readonly capabilities = {
    supportsSessionResume: false,
    supportsCompaction: false,
    supportsToolStreaming: false,
    supportsParallelToolCalls: false,
  } as const;

  constructor(
    private readonly text: string | ((input: RuntimeTurnInput) => string),
    private readonly onTurn?: (input: RuntimeTurnInput) => Promise<void> | void,
    private readonly artifacts?:
      | ArtifactRef[]
      | ((input: RuntimeTurnInput) => ArtifactRef[]),
    private readonly delivery?: ReturnType<typeof deliveredWithLimitationsState>,
  ) {}

  async createSession(
    input: RuntimeSessionInit,
  ): Promise<RuntimeSessionHandle> {
    return {
      sessionId: input.sessionId,
      role: input.role,
      runtimeAdapterId: this.id,
      runtimeSessionRef: `app-test:${input.sessionId}`,
    };
  }

  async runTurn(input: RuntimeTurnInput) {
    this.turns.push(input);
    await this.onTurn?.(input);
    const text = typeof this.text === "function" ? this.text(input) : this.text;
    const artifacts =
      typeof this.artifacts === "function"
        ? this.artifacts(input)
        : this.artifacts;
    return {
      text,
      runtimeSessionRef: input.handle.runtimeSessionRef,
      artifacts,
      delivery: this.delivery,
    };
  }
}

class HangingRuntime implements AgentRuntimeAdapter {
  readonly id = "app-hanging-runtime";
  sawSignal = false;
  aborted = false;
  readonly capabilities = {
    supportsSessionResume: false,
    supportsCompaction: false,
    supportsToolStreaming: false,
    supportsParallelToolCalls: false,
  } as const;

  async createSession(
    input: RuntimeSessionInit,
  ): Promise<RuntimeSessionHandle> {
    return {
      sessionId: input.sessionId,
      role: input.role,
      runtimeAdapterId: this.id,
      runtimeSessionRef: `app-hanging:${input.sessionId}`,
    };
  }

  async runTurn(input: RuntimeTurnInput) {
    this.sawSignal = input.signal instanceof AbortSignal;
    input.signal?.addEventListener("abort", () => {
      this.aborted = true;
    });
    return await new Promise<never>(() => undefined);
  }
}

const fakeProvider: ModelProviderAdapter = {
  id: "fake-provider",
  capabilities: {
    supportsStreaming: false,
    supportsToolCalls: true,
    supportsImages: false,
    supportsAudio: false,
    supportsServerThreads: false,
    supportsReasoningConfig: true,
    supportsPromptCaching: true,
  },
  async invoke() {
    return { text: "unused" };
  },
};
