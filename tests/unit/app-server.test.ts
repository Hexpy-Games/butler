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
import { createProjectFolderSelectionToken } from "../../packages/butler-agent/src/gateways/app/store.ts";
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
import { WorkStreamStore } from "../../packages/butler-agent/src/agent/work/work-stream.ts";
import { ModelProviderRequestError } from "../../packages/butler-agent/src/integrations/providers/provider-errors.ts";
import {
  discoverLocalModels,
  upsertLocalModelConfig,
} from "../../packages/butler-agent/src/integrations/providers/local-models.ts";
import { appendPromptCacheMetric } from "../../packages/butler-agent/src/integrations/providers/prompt-cache-metrics.ts";
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
const packageVersion = JSON.parse(
  readFileSync(join(process.cwd(), "package.json"), "utf8"),
).version as string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "butler-app-server-"));
  originalFetch = globalThis.fetch;
  originalButlerData = process.env.BUTLER_DATA;
  originalButlerHome = process.env.BUTLER_HOME;
  originalOpenAiApiKey = process.env.OPENAI_API_KEY;
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
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    butlerData: tempDir,
    butlerHome: process.cwd(),
    port: 0,
  });
  try {
    const status = await getJson(`${server.url}updates`);
    expect(
      status.data.components.map(
        (item: { component: string }) => item.component,
      ),
    ).toEqual(["service", "app"]);
    expect(
      status.data.components.every(
        (item: { current_version: string }) =>
          item.current_version === packageVersion,
      ),
    ).toBe(true);

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
    expect(sent.data.reply.text).toBe("done");
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
      phase: "consolidating",
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
    ).toEqual(["20260501010102", "20260501010099"]);
    expect(projectSummary.data.worker_activity[0]).toMatchObject({
      session_id: projectSessionId,
      project_id: projectId,
      objective: "Safe worker summary 20260501010102",
    });
    expect(projectSummary.data.worker_activity[1]).toMatchObject({
      task_id: "20260501010099",
      phase: "executing",
      project_id: projectId,
      objective: "Background worker task",
    });

    const global = await getJson(
      `${server.url}worker-activity?include_history=true`,
    );
    expect(
      global.data.workers.map((worker: { task_id: string }) => worker.task_id),
    ).toEqual([
      "20260501010103",
      "20260501010102",
      "20260501010101",
      "20260501010100",
      "20260501010099",
    ]);
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
    expect(sessionAssistant.attachments).toHaveLength(1);
    expect(sessionView.data.artifacts).toContainEqual(
      expect.objectContaining({ title: "queued-result.md" }),
    );
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
    ).toEqual(["cancel stale app result"]);

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
        AND payload_json LIKE ? ESCAPE '\\'
    `,
      )
      .get(`%"turn_id":"${turnId}"%`);
    expect(row?.count).toBe(1);
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

    const turns = await getJson(`${server.url}turns?chat_id=general`);
    expect(turns.data.turns).toHaveLength(1);
    expect(turns.data.turns[0]).toMatchObject({
      id: turnId,
      state: "failed",
      safe_error_code: "gateway_failed",
      cancellable: false,
      retryable: true,
    });
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
  expect(first.status).toBe(500);
  const failedTurns = await getJson(`${server.url}turns?chat_id=general`);
  const turnId = failedTurns.data.turns[0].id;
  expect(failedTurns.data.turns[0].state).toBe("failed");
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
  expect(first.status).toBe(500);
  const failedTurns = await getJson(`${server.url}turns?chat_id=general`);
  const turnId = failedTurns.data.turns[0].id;
  expect(failedTurns.data.turns[0].state).toBe("failed");
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
    expect(sent.data.reply.attachments[0]).toMatchObject({
      kind: "text",
      mime_type: "text/plain",
      safe_name: "result.txt",
    });
    expect(sent.data.reply.artifacts[0]).toMatchObject({
      file_id: sent.data.reply.attachments[0].file_id,
      message_id: sent.data.reply.id,
      turn_id: sent.data.reply.turn_id,
      title: "result.txt",
      kind: "document",
      open_action: "route",
      url: sent.data.reply.attachments[0].url,
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
        file_id: sent.data.reply.attachments[0].file_id,
        message_id: sent.data.reply.id,
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
    expect(check.data.reply.text).toBe(
      `Butler Agent is up to date (${packageVersion}).`,
    );
    expect(runtime.turns).toHaveLength(0);

    const apply = await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "/update apply",
    });
    expect(apply.data.reply.text).toBe(
      `Butler Agent is up to date (${packageVersion}).`,
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
    expect(result.data.reply.text).toBe("gateway bridge reply");
    expect(result.data.reply.attachments[0]).toMatchObject({
      kind: "text",
      mime_type: "text/csv",
      safe_name: "runtime-result.csv",
    });
    expect(result.data.reply.artifacts[0]).toMatchObject({
      file_id: result.data.reply.attachments[0].file_id,
      title: "runtime-result.csv",
      kind: "csv_file",
      open_action: "route",
    });
    expect(JSON.stringify(result)).not.toContain(runtimeArtifactPath);
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
    expect(result.data.reply.text).toBe("gateway bridge reply");
    expect(result.data.reply.attachments[0]).toMatchObject({
      kind: "text",
      mime_type: "text/csv",
      safe_name: artifactName,
    });
    expect(result.data.reply.attachments[0].safe_name).not.toContain("_");
    expect(result.data.reply.artifacts[0]).toMatchObject({
      file_id: result.data.reply.attachments[0].file_id,
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
    expect(result.data.reply.attachments[0]).toMatchObject({
      kind: "text",
      mime_type: "text/csv",
      safe_name: artifactName,
    });
    expect(result.data.reply.artifacts[0]).toMatchObject({
      file_id: result.data.reply.attachments[0].file_id,
      title: artifactName,
      kind: "csv_file",
      open_action: "route",
      url: `/message-files/${result.data.reply.attachments[0].file_id}`,
    });

    const download = await fetch(
      new URL(result.data.reply.artifacts[0].url, server.url),
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
    expect(first.data.reply.text).toBe(firstFinal);

    const second = await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "second app turn",
    });
    expect(second.data.reply.text).toBe("SECOND_APP_GATEWAY_SAW_FIRST");
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
      expect(result.data.reply.text).toBe("local bridge reply");
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
    expect(result.data.reply.text).toBe(
      "gateway bridge reply: route this with progress",
    );
    const second = await postJson(`${server.url}messages`, {
      chat_id: "general",
      text: "route this again",
    });
    expect(second.data.reply.text).toBe(
      "gateway bridge reply: route this again",
    );

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
        safe_progress_rows: [
          expect.objectContaining({
            kind: "ran_command",
            safe_tool_name: "Bash",
          }),
        ],
      });
    }
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

test("hung responders return a bounded timeout error and receive abort signal", async () => {
  let aborted = false;
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
    responderTimeoutMs: 25,
    responder(input) {
      input.signal?.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise(() => undefined);
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
    expect(response.status).toBe(504);
    expect(body.protocol_version).toBe("butler.app.v1");
    expect(body.error.code).toBe("gateway_timeout");
    expect(aborted).toBe(true);
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
    expect(failed).toMatchObject({
      role: "assistant",
      safe_error_code: "gateway_timeout",
      retryable: true,
    });

    const turns = await getJson(`${server.url}turns?chat_id=general&cursor=0`);
    expect(turns.data.turns[0]).toMatchObject({
      state: "failed",
      safe_error_code: "gateway_timeout",
      retryable: true,
      cancellable: false,
    });
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
      state: "cancelled",
      retryable: false,
      cancellable: false,
    });
    expect(body.data.replies).toEqual([]);
    expect(aborted).toBe(true);

    const messages = await getJson(
      `${server.url}messages?chat_id=general&cursor=0`,
    );
    expect(
      messages.data.messages.map(
        (message: { status: string }) => message.status,
      ),
    ).toEqual(["sent"]);
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
    expect(failedResponse.status).toBe(500);
    expect(failedBody.error.code).toBe("internal_error");
    expect(JSON.stringify(failedBody)).not.toContain("private provider stack");

    const turns = await getJson(`${server.url}turns?chat_id=general&cursor=0`);
    const failedTurn = turns.data.turns[0];
    expect(failedTurn).toMatchObject({
      state: "failed",
      safe_error_code: "gateway_failed",
      retryable: true,
      attempt: 1,
    });

    const retry = await postJson(
      `${server.url}turns/${encodeURIComponent(failedTurn.id)}/retry`,
      {},
    );
    expect(retry.data.turn).toMatchObject({
      state: "delivered",
      retryable: false,
      cancellable: false,
      attempt: 2,
    });
    expect(retry.data.reply.text).toBe("recovered reply");

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
    expect(failedResponse.status).toBe(500);

    const turns = await getJson(`${server.url}turns?chat_id=general&cursor=0`);
    const failedTurn = turns.data.turns[0];
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

    const retryResponse = await fetch(
      `${server.url}turns/${encodeURIComponent(failedTurn.id)}/retry`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(retryResponse.status).toBe(500);

    messages = await getJson(`${server.url}messages?chat_id=general&cursor=0`);
    const assistantMessages = messages.data.messages.filter(
      (message: { role: string }) => message.role === "assistant",
    );
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]).toMatchObject({
      id: firstAssistant.id,
      status: "failed",
      safe_error_code: "provider_empty_response",
      retryable: true,
    });
    expect(assistantMessages[0].text).toContain("no visible answer");
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
    expect(failedResponse.status).toBe(500);

    const turns = await getJson(`${server.url}turns?chat_id=general&cursor=0`);
    expect(turns.data.turns[0]).toMatchObject({
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
  } finally {
    server.stop();
  }
});

test("goal completion incomplete failures persist the safe incomplete reason", async () => {
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
    const failedResponse = await fetch(`${server.url}messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: "general",
        text: "complete this only with verified evidence",
      }),
    });
    expect(failedResponse.status).toBe(500);

    const turns = await getJson(`${server.url}turns?chat_id=general&cursor=0`);
    const failedTurn = turns.data.turns[0];
    expect(failedTurn).toMatchObject({
      state: "failed",
      safe_error_code: "goal_completion_incomplete",
      retryable: true,
    });

    const messages = await getJson(
      `${server.url}messages?chat_id=general&cursor=0`,
    );
    const firstAssistant = messages.data.messages.find(
      (message: { role: string }) => message.role === "assistant",
    );
    expect(firstAssistant).toMatchObject({
      status: "failed",
      safe_error_code: "goal_completion_incomplete",
      retryable: true,
    });
    expect(firstAssistant.text).toContain("확인 가능한 공개 출처");
    expect(firstAssistant.text).not.toContain("token=secret");
  } finally {
    server.stop();
  }
});

test("goal completion obligation protocol failures render as clean retryable failures", async () => {
  const server = createAppServer({
    dbPath: join(tempDir, "app.sqlite"),
    port: 0,
    responder() {
      const error = new Error(
        "The turn still has unsatisfied public completion obligation(s): durable_artifact, data_table_created.",
      );
      error.name = "GoalCompletionIncompleteError";
      throw error;
    },
  });
  try {
    const failedResponse = await fetch(`${server.url}messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: "general",
        text: "create a csv and report",
      }),
    });
    expect(failedResponse.status).toBe(500);

    const messages = await getJson(
      `${server.url}messages?chat_id=general&cursor=0`,
    );
    const firstAssistant = messages.data.messages.find(
      (message: { role: string }) => message.role === "assistant",
    );
    expect(firstAssistant).toMatchObject({
      status: "failed",
      safe_error_code: "goal_completion_incomplete",
      retryable: true,
    });
    expect(firstAssistant.text).toContain(
      "요청한 결과를 완료했는지 확인하지 못했습니다",
    );
    expect(firstAssistant.text).not.toContain(
      "unsatisfied public completion obligation",
    );
    expect(firstAssistant.text).not.toContain("durable_artifact");
    expect(firstAssistant.text).not.toContain("data_table_created");
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
    const turns = await getJson(`${server.url}turns?chat_id=general&cursor=0`);
    const turnId = turns.data.turns[0].id;

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

    const finalTurns = await getJson(
      `${server.url}turns?chat_id=general&cursor=0`,
    );
    expect(finalTurns.data.turns[0]).toMatchObject({
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

test("gateway bridge propagates timeout abort signal to runtime turns", async () => {
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
    expect(response.status).toBe(504);
    expect(body.error.code).toBe("gateway_timeout");
    expect(runtime.sawSignal).toBe(true);
    expect(runtime.aborted).toBe(true);
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

test("app server allows the default local Vite dev origin", async () => {
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

    const rejected = await fetch(`${server.url}health`, {
      headers: { origin: "http://127.0.0.1:5174" },
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
