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
  AGENT_STOP_INTENT_SCHEMA,
  agentStopIntentPath,
  decideAgentExit,
  nativeServiceInstancePath,
  parseAgentStopIntent,
  parseNativeServiceInstance,
  readAgentStopIntent,
  readNativeServiceInstance,
  selectReplacementInstance,
  writeAgentStopIntent,
} from "../../packages/butler-app/client/electron/app-agent-stop-intent.mjs";

const validIntent = {
  schema: "butler.agent-stop-intent.v1",
  reason: "stop",
  requested_by: "cli",
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

test("a well-formed stop or restart intent parses for every requester", () => {
  for (const reason of ["stop", "restart"] as const) {
    for (const requestedBy of ["cli", "app", "mcp"] as const) {
      expect(parseAgentStopIntent(JSON.stringify({
        ...validIntent,
        reason,
        requested_by: requestedBy,
      }))).toEqual({
        reason,
        requestedBy,
        instanceId: "nonce-a",
        pid: 4242,
        requestedAt: "2026-09-27T10:00:00Z",
      });
    }
  }
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

test("exit decision table: stop sticks, restart waits, everything else is a crash", () => {
  const stop = parseAgentStopIntent(JSON.stringify(validIntent));
  const restart = parseAgentStopIntent(JSON.stringify({ ...validIntent, reason: "restart" }));
  const exited = { pid: 4242, instanceId: "nonce-a" };

  expect(decideAgentExit({ intent: stop, exited })).toMatchObject({
    action: "stay_stopped",
    requestedBy: "cli",
  });
  expect(decideAgentExit({ intent: restart, exited })).toMatchObject({
    action: "await_restart",
    requestedBy: "cli",
  });
  expect(decideAgentExit({ intent: null, exited })).toMatchObject({
    action: "recover",
    cause: "no_intent",
  });
  expect(decideAgentExit({ intent: parseAgentStopIntent("{"), exited }))
    .toMatchObject({ action: "recover", cause: "no_intent" });
});

test("the intent matches on the instance nonce alone, never on the pid", () => {
  const stop = parseAgentStopIntent(JSON.stringify(validIntent));
  expect(decideAgentExit({ intent: stop, exited: { pid: 5000, instanceId: "nonce-a" } }))
    .toMatchObject({ action: "stay_stopped" });
  expect(decideAgentExit({ intent: stop, exited: { pid: 4242, instanceId: "nonce-b" } }))
    .toMatchObject({ action: "recover", cause: "instance_mismatch" });
  for (const exited of [{ pid: 4242, instanceId: null }, { pid: 4242 }, null]) {
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
    port: 18801,
  });
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
