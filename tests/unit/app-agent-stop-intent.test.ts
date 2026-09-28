import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "bun:test";
import {
  AGENT_RESTART_RECONNECT_TIMEOUT_MS,
  AGENT_STOP_DRAIN_EXIT_MS,
  AGENT_STOP_INTENT_SCHEMA,
  AGENT_STOP_KILL_TIMEOUT_MS,
  agentStopIntentPath,
  decideAgentExit,
  nativeServiceInstancePath,
  parseAgentStopIntent,
  parseNativeServiceInstance,
  readAgentStopIntent,
  readNativeServiceInstance,
  retractAgentStopIntent,
  selectReplacementInstance,
  writeAgentStopIntent,
} from "../../packages/butler-app/client/electron/app-agent-stop-intent.mjs";

const validIntent = {
  schema: "butler.agent-stop-intent.v1",
  reason: "stop",
  requested_by: "cli",
  respawn_by: null,
  instance_id: "nonce-a",
  pid: 4242,
  requested_at: "2026-09-27T10:00:00Z",
};

test("stop intent lives in the shared DATA state directory", () => {
  expect(AGENT_STOP_INTENT_SCHEMA).toBe("butler.agent-stop-intent.v1");
  expect(agentStopIntentPath("/data")).toBe("/data/state/agent-stop-intent.json");
  expect(nativeServiceInstancePath("/data")).toBe(
    "/data/state/butler-agent-native-service.json",
  );
});

test("external restart reconnect timeout is 90 seconds", () => {
  expect(AGENT_RESTART_RECONNECT_TIMEOUT_MS).toBe(90_000);
});

test("an announced stop self-exits at 6 s, before the controllers' 8 s SIGKILL", () => {
  expect(AGENT_STOP_DRAIN_EXIT_MS).toBe(6_000);
  expect(AGENT_STOP_KILL_TIMEOUT_MS).toBe(8_000);
  expect(AGENT_STOP_KILL_TIMEOUT_MS).toBeGreaterThan(AGENT_STOP_DRAIN_EXIT_MS);
});

test("a well-formed stop or restart intent parses for every requester and respawner", () => {
  for (const reason of ["stop", "restart"] as const) {
    for (const requestedBy of ["cli", "app", "mcp"] as const) {
      for (const respawnBy of ["app", "controller", null] as const) {
        expect(parseAgentStopIntent(JSON.stringify({
          ...validIntent,
          reason,
          requested_by: requestedBy,
          respawn_by: respawnBy,
        }))).toEqual({
          reason,
          requestedBy,
          respawnBy,
          instanceId: "nonce-a",
          pid: 4242,
          requestedAt: "2026-09-27T10:00:00Z",
        });
      }
    }
  }
});

test("an intent without respawn_by (an older writer) parses with respawnBy null", () => {
  const { respawn_by: _respawnBy, ...withoutRespawnBy } = validIntent;
  expect(parseAgentStopIntent(JSON.stringify({ ...withoutRespawnBy, reason: "restart" })))
    .toMatchObject({ reason: "restart", respawnBy: null });
});

test("malformed, unknown-schema, or incomplete intents parse to null and never throw", () => {
  const { schema: _schema, ...withoutSchema } = validIntent;
  const candidates: unknown[] = [
    undefined,
    null,
    "",
    "{",
    "not json",
    "null",
    "[]",
    "42",
    JSON.stringify([validIntent]),
    JSON.stringify(withoutSchema),
    JSON.stringify({ ...validIntent, schema: "butler.agent-stop-intent.v2" }),
    JSON.stringify({ ...validIntent, reason: "pause" }),
    JSON.stringify({ ...validIntent, reason: undefined }),
    JSON.stringify({ ...validIntent, requested_by: "someone" }),
    JSON.stringify({ ...validIntent, requested_by: undefined }),
    JSON.stringify({ ...validIntent, respawn_by: "launchd" }),
    JSON.stringify({ ...validIntent, respawn_by: "" }),
    JSON.stringify({ ...validIntent, respawn_by: "App" }),
    JSON.stringify({ ...validIntent, respawn_by: true }),
    JSON.stringify({ ...validIntent, respawn_by: 1 }),
    JSON.stringify({ ...validIntent, respawn_by: {} }),
    JSON.stringify({ ...validIntent, instance_id: "" }),
    JSON.stringify({ ...validIntent, instance_id: 7 }),
    JSON.stringify({ ...validIntent, instance_id: undefined }),
    JSON.stringify({ ...validIntent, pid: "4242" }),
    JSON.stringify({ ...validIntent, pid: 0 }),
    JSON.stringify({ ...validIntent, pid: -1 }),
    JSON.stringify({ ...validIntent, pid: 1.5 }),
    JSON.stringify({ ...validIntent, pid: undefined }),
    JSON.stringify({ ...validIntent, requested_at: "" }),
    JSON.stringify({ ...validIntent, requested_at: "yesterday" }),
    JSON.stringify({ ...validIntent, requested_at: undefined }),
    Buffer.from([0xff, 0xfe, 0x00]),
    { toString() { throw new Error("boom"); } },
  ];
  for (const candidate of candidates) {
    expect(() => parseAgentStopIntent(candidate)).not.toThrow();
    expect(parseAgentStopIntent(candidate)).toBeNull();
  }
});

test("reading the intent file tolerates a missing or corrupt file", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-stop-intent-read-"));
  try {
    expect(readAgentStopIntent(root)).toBeNull();
    mkdirSync(dirname(agentStopIntentPath(root)), { recursive: true });
    writeFileSync(agentStopIntentPath(root), "{ broken");
    expect(readAgentStopIntent(root)).toBeNull();
    writeFileSync(agentStopIntentPath(root), JSON.stringify(validIntent));
    expect(readAgentStopIntent(root)).toMatchObject({ reason: "stop", pid: 4242 });
    expect(readAgentStopIntent(root, {
      readFile: () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
    })).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const child = { pid: 4242, instanceId: "nonce-a", spawnedByApp: true, appSupervised: true };
const attached = { pid: 4242, instanceId: "nonce-a", spawnedByApp: false, appSupervised: false };

function intent(patch: Record<string, unknown>) {
  return parseAgentStopIntent(JSON.stringify({ ...validIntent, ...patch }));
}

test("exit decision table", () => {
  const rows: Array<[
    string,
    ReturnType<typeof intent>,
    Record<string, unknown>,
    Record<string, unknown>,
  ]> = [
    ["stop of the App's child", intent({ reason: "stop" }), child,
      { action: "stay_stopped", requestedBy: "cli" }],
    ["stop of an attached Agent", intent({ reason: "stop" }), attached,
      { action: "stay_stopped", requestedBy: "cli" }],
    ["stop ignores a stray respawn_by", intent({ reason: "stop", respawn_by: "app" }), child,
      { action: "stay_stopped" }],
    ["restart, respawn_by app, the App's child: the App respawns",
      intent({ reason: "restart", respawn_by: "app" }), child,
      { action: "respawn", requestedBy: "cli", respawnBy: "app" }],
    ["restart, respawn_by app, another App's leased Agent: wait for its replacement",
      intent({ reason: "restart", respawn_by: "app" }), { ...attached, appSupervised: true },
      { action: "await_restart", respawnBy: "app" }],
    ["restart, respawn_by app, a detached Agent: wait (bounded)",
      intent({ reason: "restart", respawn_by: "app" }), attached,
      { action: "await_restart", respawnBy: "app" }],
    ["restart, respawn_by controller, the App's child: the controller respawns",
      intent({ reason: "restart", respawn_by: "controller" }), child,
      { action: "await_restart", respawnBy: "controller" }],
    ["restart, respawn_by controller, an attached Agent",
      intent({ reason: "restart", respawn_by: "controller" }), attached,
      { action: "await_restart", respawnBy: "controller" }],
    ["restart, respawn_by null: treated as controller",
      intent({ reason: "restart", respawn_by: null }), child,
      { action: "await_restart", respawnBy: "controller" }],
    ["restart, respawn_by missing: treated as controller",
      intent({ reason: "restart", respawn_by: undefined }), child,
      { action: "await_restart", respawnBy: "controller" }],
    ["no intent: crash", null, child, { action: "recover", cause: "no_intent" }],
    ["unknown respawn_by: crash", intent({ reason: "restart", respawn_by: "launchd" }), child,
      { action: "recover", cause: "no_intent" }],
    ["malformed intent: crash", parseAgentStopIntent("{"), child,
      { action: "recover", cause: "no_intent" }],
  ];
  for (const [label, candidate, exited, expected] of rows) {
    expect({ label, decision: decideAgentExit({ intent: candidate, exited }) })
      .toMatchObject({ label, decision: expected });
  }
});

test("the intent matches only when both the nonce and the pid name the exited Agent", () => {
  const stop = intent({ reason: "stop" });
  expect(decideAgentExit({ intent: stop, exited: child })).toMatchObject({ action: "stay_stopped" });
  expect(decideAgentExit({ intent: stop, exited: { ...child, pid: 5000 } }))
    .toMatchObject({ action: "recover", cause: "instance_mismatch" });
  expect(decideAgentExit({ intent: stop, exited: { ...child, instanceId: "nonce-b" } }))
    .toMatchObject({ action: "recover", cause: "instance_mismatch" });
  for (const exited of [
    { ...child, instanceId: null },
    { pid: 4242 },
    { ...child, pid: null },
    { instanceId: "nonce-a" },
    null,
  ]) {
    expect(decideAgentExit({ intent: stop, exited }))
      .toMatchObject({ action: "recover", cause: "instance_unknown" });
  }
});

test("app-written intent is atomic, private, and parses back", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-stop-intent-write-"));
  try {
    const written = writeAgentStopIntent(root, {
      reason: "restart",
      pid: 777,
      instanceId: "nonce-app",
      now: () => new Date("2026-09-27T11:00:00.000Z"),
    });
    expect(written).toEqual({
      schema: AGENT_STOP_INTENT_SCHEMA,
      reason: "restart",
      requested_by: "app",
      respawn_by: null,
      instance_id: "nonce-app",
      pid: 777,
      requested_at: "2026-09-27T11:00:00.000Z",
    });
    const path = agentStopIntentPath(root);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(written);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(dirname(path)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(readAgentStopIntent(root)).toMatchObject({
      reason: "restart",
      requestedBy: "app",
      pid: 777,
      instanceId: "nonce-app",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("app-written intents carry respawn_by: app for a restart it respawns, null for a stop", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-stop-intent-respawn-"));
  try {
    expect(writeAgentStopIntent(root, {
      reason: "restart",
      respawnBy: "app",
      pid: 777,
      instanceId: "nonce-app",
    })).toMatchObject({ reason: "restart", respawn_by: "app" });
    expect(readAgentStopIntent(root)).toMatchObject({ reason: "restart", respawnBy: "app" });
    expect(writeAgentStopIntent(root, { reason: "stop", pid: 777, instanceId: "nonce-app" }))
      .toMatchObject({ reason: "stop", respawn_by: null });
    expect(() => writeAgentStopIntent(root, {
      reason: "restart",
      // @ts-expect-error an unknown respawner is rejected
      respawnBy: "launchd",
      pid: 777,
      instanceId: "nonce-app",
    })).toThrow("invalid Agent stop intent");
    expect(readAgentStopIntent(root)).toMatchObject({ reason: "stop", respawnBy: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retracting an intent removes it only while it still names that instance", () => {
  const root = mkdtempSync(join(tmpdir(), "butler-stop-intent-retract-"));
  try {
    expect(retractAgentStopIntent(root, { pid: 777, instanceId: "nonce-app" })).toBe(false);
    writeAgentStopIntent(root, { reason: "stop", pid: 777, instanceId: "nonce-app" });
    expect(retractAgentStopIntent(root, { pid: 777, instanceId: "nonce-other" })).toBe(false);
    expect(retractAgentStopIntent(root, { pid: 778, instanceId: "nonce-app" })).toBe(false);
    expect(readAgentStopIntent(root)).not.toBeNull();
    expect(retractAgentStopIntent(root, { pid: 777, instanceId: "nonce-app" })).toBe(true);
    expect(readAgentStopIntent(root)).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const readyRecord = {
  schema: "butler.native-agent-service-instance.v1",
  nonce: "nonce-new",
  pid: 5151,
  process_start: "start",
  executable: "/bin/butler-agent",
  state: "ready",
  app_enabled: true,
  app_endpoint: "http://127.0.0.1:18801",
  app_auth_required: false,
  ready_at: "2026-09-27T10:00:05Z",
};

test("native service instance record parses defensively", () => {
  expect(parseNativeServiceInstance(JSON.stringify(readyRecord))).toEqual({
    pid: 5151,
    instanceId: "nonce-new",
    state: "ready",
    appEnabled: true,
    appSupervised: false,
    port: 18801,
  });
  expect(parseNativeServiceInstance(JSON.stringify({ ...readyRecord, app_supervised: true }))
    ?.appSupervised).toBe(true);
  for (const value of [false, "true", 1, null]) {
    expect(parseNativeServiceInstance(JSON.stringify({ ...readyRecord, app_supervised: value }))
      ?.appSupervised).toBe(false);
  }
  expect(parseNativeServiceInstance(JSON.stringify({
    ...readyRecord,
    app_endpoint: "http://localhost:18802/",
  }))?.port).toBe(18802);
  for (const candidate of [
    "{",
    JSON.stringify({ ...readyRecord, schema: "other" }),
    JSON.stringify({ ...readyRecord, pid: "5151" }),
    JSON.stringify({ ...readyRecord, nonce: "" }),
  ]) {
    expect(parseNativeServiceInstance(candidate)).toBeNull();
  }
  for (const endpoint of [null, "https://127.0.0.1:18801", "http://192.0.2.10:18801", "nope"]) {
    expect(parseNativeServiceInstance(JSON.stringify({
      ...readyRecord,
      app_endpoint: endpoint,
    }))?.port).toBeNull();
  }
  const root = mkdtempSync(join(tmpdir(), "butler-native-record-"));
  try {
    expect(readNativeServiceInstance(root)).toBeNull();
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(nativeServiceInstancePath(root), JSON.stringify(readyRecord));
    expect(readNativeServiceInstance(root)?.instanceId).toBe("nonce-new");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a replacement must be a different (by nonce), live, ready, app-enabled instance", () => {
  const record = parseNativeServiceInstance(JSON.stringify(readyRecord));
  const alive = () => true;
  expect(selectReplacementInstance(record, {
    exitedInstanceId: "nonce-old",
    isProcessAlive: alive,
  })).toEqual(record);
  expect(selectReplacementInstance(record, {
    exitedInstanceId: "nonce-new",
    isProcessAlive: alive,
  })).toBeNull();
  expect(selectReplacementInstance(record, {
    exitedInstanceId: "nonce-old",
    isProcessAlive: () => false,
  })).toBeNull();
  for (const patch of [
    { state: "starting" },
    { state: "stopping" },
    { app_enabled: false },
    { app_endpoint: null },
  ]) {
    expect(selectReplacementInstance(
      parseNativeServiceInstance(JSON.stringify({ ...readyRecord, ...patch })),
      { exitedInstanceId: "nonce-old", isProcessAlive: alive },
    )).toBeNull();
  }
  expect(selectReplacementInstance(null, {
    exitedInstanceId: null,
    isProcessAlive: alive,
  })).toBeNull();
});
