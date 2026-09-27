import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  appLocalAuthPath,
  createBundledAgentSupervisor,
  prepareAppLocalAuth,
} from "../../packages/butler-app/client/electron/app-agent-supervisor.mjs";
import {
  agentStopIntentPath,
  nativeServiceInstancePath,
} from "../../packages/butler-app/client/electron/app-agent-stop-intent.mjs";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "butler-supervisor-intent-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("an external stop sticks: no respawn, no crash recovery, stopped state", async () => {
  const h = createHarness();
  await h.supervisor.ensureReady();
  const child = h.spawned[0]!;
  h.writeIntent({ reason: "stop", pid: child.pid, instance_id: `nonce-${child.pid}` });

  h.exitChild(child, null, "SIGTERM");
  await flush();

  expect(h.events.unexpected).toBe(0);
  expect(h.events.intentional).toEqual([{ reason: "stop", requestedBy: "cli" }]);
  expect(h.supervisor.agentState()).toMatchObject({ state: "stopped", requested_by: "cli" });
  await expect(h.supervisor.ensureReady()).rejects.toMatchObject({ code: "agent_stopped" });
  expect(h.spawned).toHaveLength(1);
});

test("start from the stopped state ignores the leftover intent and spawns normally", async () => {
  const h = createHarness();
  await h.supervisor.ensureReady();
  const first = h.spawned[0]!;
  h.writeIntent({ reason: "stop", pid: first.pid, instance_id: `nonce-${first.pid}` });
  h.exitChild(first, null, "SIGTERM");
  await flush();

  await h.supervisor.resume();

  expect(h.spawned).toHaveLength(2);
  expect(existsSync(agentStopIntentPath(h.butlerData))).toBe(true);
  expect(h.supervisor.agentState().state).toBe("running");
});

test("a leftover intent on app launch is ignored", async () => {
  const h = createHarness();
  h.writeIntent({ reason: "stop", pid: 9100, instance_id: "nonce-from-last-week" });

  await h.supervisor.ensureReady();

  expect(h.spawned).toHaveLength(1);
  expect(h.supervisor.agentState().state).toBe("running");
});

test("an external restart waits for the new instance and reconnects without spawning", async () => {
  const h = createHarness();
  await h.supervisor.ensureReady();
  const child = h.spawned[0]!;
  h.writeIntent({ reason: "restart", pid: child.pid, instance_id: `nonce-${child.pid}` });
  h.onSleep = () => {
    if (h.clock() >= 1_000) h.startExternalInstance({ pid: 7300, port: 18801 });
  };

  h.exitChild(child, null, "SIGTERM");
  expect(h.supervisor.agentState().state).toBe("restarting");
  await h.supervisor.ensureReady();
  await flush();

  expect(h.spawned).toHaveLength(1);
  expect(h.events.unexpected).toBe(0);
  expect(h.events.intentional).toEqual([{ reason: "restart", requestedBy: "cli" }]);
  expect(h.events.attached).toEqual([{ pid: 7300, instanceId: "nonce-7300", port: 18801 }]);
  expect(h.port()).toBe(18801);
  expect(h.supervisor.agentState().state).toBe("running");
});

test("a restart that never produces a new instance times out into a recoverable error", async () => {
  const h = createHarness({ restartReconnectTimeoutMs: 5_000 });
  await h.supervisor.ensureReady();
  const child = h.spawned[0]!;
  h.writeIntent({ reason: "restart", pid: child.pid, instance_id: `nonce-${child.pid}` });

  h.exitChild(child, null, "SIGTERM");
  await expect(h.supervisor.ensureReady()).rejects.toMatchObject({
    code: "agent_restart_timeout",
  });
  await flush();

  expect(h.clock()).toBeGreaterThanOrEqual(5_000);
  expect(h.events.restartFailed).toBe(1);
  expect(h.supervisor.agentState().state).toBe("restart_failed");
  await expect(h.supervisor.ensureReady()).rejects.toMatchObject({
    code: "agent_restart_timeout",
  });
  expect(h.spawned).toHaveLength(1);

  await h.supervisor.resume();
  expect(h.spawned).toHaveLength(2);
  expect(h.supervisor.agentState().state).toBe("running");
});

test("a crash without an intent still takes the automatic recovery path", async () => {
  const h = createHarness();
  await h.supervisor.ensureReady();

  h.exitChild(h.spawned[0]!, 1, null);
  await flush();

  expect(h.events.unexpected).toBe(1);
  expect(h.events.intentional).toEqual([]);
  expect(h.supervisor.agentState().state).not.toBe("stopped");
  await h.supervisor.ensureReady();
  expect(h.spawned).toHaveLength(2);
});

test("an intent for another instance is treated as a crash even with the same pid", async () => {
  const h = createHarness();
  await h.supervisor.ensureReady();
  h.writeIntent({ reason: "stop", pid: 9100, instance_id: "nonce-other" });
  h.exitChild(h.spawned[0]!, null, "SIGTERM");
  await flush();
  expect(h.events.unexpected).toBe(1);
  expect(h.supervisor.agentState().state).not.toBe("stopped");
});

test("the intent matches the exited instance by nonce, not by pid", async () => {
  const h = createHarness();
  await h.supervisor.ensureReady();
  h.writeIntent({ reason: "stop", pid: 1234, instance_id: "nonce-9100" });
  h.exitChild(h.spawned[0]!, null, "SIGTERM");
  await flush();
  expect(h.events.unexpected).toBe(0);
  expect(h.supervisor.agentState().state).toBe("stopped");
});

test("a child that never published its instance nonce exits as a crash", async () => {
  const h = createHarness({ publishChildRecord: false });
  await h.supervisor.ensureReady();
  h.writeIntent({ reason: "stop", pid: 9100, instance_id: "nonce-9100" });
  h.exitChild(h.spawned[0]!, null, "SIGTERM");
  await flush();
  expect(h.events.unexpected).toBe(1);
});

test("reconnecting to an external instance uses the token in the shared auth file", async () => {
  const h = createHarness();
  await h.supervisor.ensureReady();
  const child = h.spawned[0]!;
  h.writeIntent({ reason: "restart", pid: child.pid, instance_id: `nonce-${child.pid}` });
  const sharedToken = "s".repeat(43);
  h.onSleep = () => {
    if (h.clock() < 1_000) return;
    writeFileSync(appLocalAuthPath(h.butlerData), JSON.stringify({
      schema: "butler.app-local-agent-auth.v1",
      token: sharedToken,
    }));
    h.startExternalInstance({ pid: 7700, port: 18802 });
  };

  h.exitChild(child, null, "SIGTERM");
  await h.supervisor.ensureReady();

  expect(h.healthTokens.get(18802)).toEqual([sharedToken]);
  expect(h.supervisor.authHeaders()).toEqual({ authorization: `Bearer ${sharedToken}` });
});

test("a malformed intent is treated as a crash", async () => {
  const h = createHarness();
  await h.supervisor.ensureReady();
  mkdirSync(dirname(agentStopIntentPath(h.butlerData)), { recursive: true });
  writeFileSync(agentStopIntentPath(h.butlerData), "{\"schema\":\"butler.agent-stop-intent.v1\"");

  h.exitChild(h.spawned[0]!, null, "SIGTERM");
  await flush();

  expect(h.events.unexpected).toBe(1);
});

test("while stopped, an externally started agent is detected and attached", async () => {
  const h = createHarness();
  await h.supervisor.ensureReady();
  const child = h.spawned[0]!;
  h.writeIntent({ reason: "stop", pid: child.pid, instance_id: `nonce-${child.pid}` });
  h.exitChild(child, null, "SIGTERM");
  await flush();

  await h.runPolls();
  expect(h.supervisor.agentState().state).toBe("stopped");

  h.startExternalInstance({ pid: 7400, port: 18765 });
  await h.runPolls();
  await flush();

  expect(h.supervisor.agentState().state).toBe("running");
  expect(h.events.attached).toEqual([{ pid: 7400, instanceId: "nonce-7400", port: 18765 }]);
  await h.supervisor.ensureReady();
  expect(h.spawned).toHaveLength(1);
});

test("an attached external agent is watched: its stop sticks and its crash recovers", async () => {
  const stopped = createHarness();
  stopped.startExternalInstance({ pid: 7500, port: 18765 });
  await stopped.supervisor.ensureReady();
  expect(stopped.spawned).toHaveLength(0);
  stopped.writeIntent({ reason: "stop", pid: 7500, instance_id: "nonce-7500" });
  stopped.stopExternalInstance(7500);
  await stopped.runPolls();
  await flush();
  expect(stopped.supervisor.agentState().state).toBe("stopped");
  expect(stopped.events.unexpected).toBe(0);
  await expect(stopped.supervisor.ensureReady()).rejects.toMatchObject({ code: "agent_stopped" });
  expect(stopped.spawned).toHaveLength(0);

  const crashed = createHarness();
  crashed.startExternalInstance({ pid: 7600, port: 18765 });
  await crashed.supervisor.ensureReady();
  crashed.stopExternalInstance(7600);
  await crashed.runPolls();
  await flush();
  expect(crashed.events.unexpected).toBe(1);
});

test("an app stop records an app intent before SIGTERM and never triggers recovery", async () => {
  const h = createHarness();
  await h.supervisor.ensureReady();
  const child = h.spawned[0]!;

  await h.supervisor.stop({ wait: true });

  expect(child.intentAtKill).toMatchObject({
    schema: "butler.agent-stop-intent.v1",
    reason: "stop",
    requested_by: "app",
    pid: child.pid,
    instance_id: `nonce-${child.pid}`,
  });
  expect(h.events.unexpected).toBe(0);
  expect(h.events.intentional).toEqual([]);
});

test("an app restart records a restart intent and clears a stopped state", async () => {
  const h = createHarness();
  await h.supervisor.ensureReady();
  const first = h.spawned[0]!;

  await h.supervisor.restart();

  expect(first.intentAtKill).toMatchObject({ reason: "restart", requested_by: "app" });
  expect(h.spawned).toHaveLength(2);

  const second = h.spawned[1]!;
  h.writeIntent({ reason: "stop", pid: second.pid, instance_id: `nonce-${second.pid}` });
  h.exitChild(second, null, "SIGTERM");
  await flush();
  expect(h.supervisor.agentState().state).toBe("stopped");

  await h.supervisor.restart();
  expect(h.spawned).toHaveLength(3);
  expect(h.supervisor.agentState().state).toBe("running");
});

test("the App reuses a shared auth file an Agent created instead of overwriting it", () => {
  const butlerData = join(root, "shared-auth");
  const path = appLocalAuthPath(butlerData);
  mkdirSync(dirname(path), { recursive: true });
  const agentWritten = JSON.stringify({ token: "t".repeat(43) });
  writeFileSync(path, agentWritten);

  const auth = prepareAppLocalAuth({ butlerData, generateToken: () => "g".repeat(43) });

  expect(auth).toMatchObject({ created: false, token: "t".repeat(43) });
  expect(readFileSync(path, "utf8")).toBe(agentWritten);
});

function createHarness(options: {
  restartReconnectTimeoutMs?: number;
  publishChildRecord?: boolean;
} = {}) {
  const butlerData = join(root, `data-${Math.random().toString(36).slice(2)}`);
  const spawned: FakeChild[] = [];
  const alive = new Set<number>();
  const serving = new Set<number>();
  const polls = new Map<number, () => unknown>();
  let pollId = 0;
  let port = 18765;
  let clock = 0;
  const events = {
    unexpected: 0,
    restartFailed: 0,
    intentional: [] as Array<{ reason: string; requestedBy: string | null }>,
    attached: [] as Array<{ pid: number; instanceId: string; port: number }>,
  };
  const healthTokens = new Map<number, string[]>();
  const harness = {
    butlerData,
    spawned,
    events,
    healthTokens,
    onSleep: () => {},
    clock: () => clock,
    port: () => port,
    supervisor: null as unknown as ReturnType<typeof createBundledAgentSupervisor>,
    writeIntent(intent: Record<string, unknown>) {
      mkdirSync(dirname(agentStopIntentPath(butlerData)), { recursive: true });
      writeFileSync(agentStopIntentPath(butlerData), JSON.stringify({
        schema: "butler.agent-stop-intent.v1",
        requested_by: "cli",
        requested_at: "2026-09-27T10:00:00Z",
        ...intent,
      }));
    },
    exitChild(child: FakeChild, code: number | null, signal: string | null) {
      alive.delete(child.pid);
      serving.delete(child.port);
      child.emit("exit", code, signal);
    },
    startExternalInstance({ pid, port: externalPort }: { pid: number; port: number }) {
      alive.add(pid);
      serving.add(externalPort);
      writeRecord({ pid, port: externalPort });
    },
    stopExternalInstance(pid: number) {
      alive.delete(pid);
      serving.clear();
    },
    async runPolls() {
      const pending = [...polls.values()];
      polls.clear();
      for (const fn of pending) await fn();
    },
  };

  function writeRecord({ pid, port: recordPort }: { pid: number; port: number }) {
    mkdirSync(dirname(nativeServiceInstancePath(butlerData)), { recursive: true });
    writeFileSync(nativeServiceInstancePath(butlerData), JSON.stringify({
      schema: "butler.native-agent-service-instance.v1",
      nonce: `nonce-${pid}`,
      pid,
      process_start: "start",
      executable: "/runtime/butler-agent",
      state: "ready",
      app_enabled: true,
      app_endpoint: `http://127.0.0.1:${recordPort}`,
      app_auth_required: true,
      ready_at: "2026-09-27T10:00:00Z",
    }));
  }

  harness.supervisor = createBundledAgentSupervisor({
    butlerData,
    resolveGateway: () => ({
      command: "/runtime/butler-agent",
      args: ["service", "run"],
      env: {},
    }),
    spawnProcess: () => {
      const child = new FakeChild(9100 + spawned.length * 100, port, butlerData, (exited) => {
        alive.delete(exited.pid);
        serving.delete(exited.port);
      });
      spawned.push(child);
      alive.add(child.pid);
      serving.add(port);
      if (options.publishChildRecord !== false) writeRecord({ pid: child.pid, port });
      return child;
    },
    healthCheck: (localAuth) => {
      if (serving.has(port) && localAuth?.token) {
        healthTokens.set(port, [...(healthTokens.get(port) ?? []), localAuth.token]);
      }
      return serving.has(port);
    },
    readinessCheck: () => serving.has(port),
    isPortAvailable: (candidate) => !serving.has(candidate),
    findAvailablePort: (candidate) => candidate,
    updatePort: (next) => {
      port = next;
    },
    getPort: () => port,
    getServerUrl: () => `http://127.0.0.1:${port}/`,
    getRendererOrigin: () => `http://127.0.0.1:${port}`,
    sleepMs: async (ms) => {
      clock += ms;
      harness.onSleep();
    },
    nowMs: () => clock,
    setKillTimer: () => "timer",
    clearKillTimer: () => undefined,
    startupAttempts: 3,
    restartReconnectTimeoutMs: options.restartReconnectTimeoutMs ?? 60_000,
    externalPollMs: 500,
    isProcessAlive: (pid) => alive.has(pid),
    schedulePoll: (fn) => {
      pollId += 1;
      polls.set(pollId, fn);
      return pollId;
    },
    cancelPoll: (id) => {
      polls.delete(id as number);
    },
    onUnexpectedExit: () => {
      events.unexpected += 1;
    },
    onIntentionalExit: ({ reason, requestedBy }) => {
      events.intentional.push({ reason, requestedBy });
    },
    onExternalAttach: ({ pid, instanceId, port: attachedPort }) => {
      events.attached.push({ pid, instanceId, port: attachedPort });
    },
    onRestartReconnectFailed: () => {
      events.restartFailed += 1;
    },
  });
  return harness;
}

class FakeChild extends EventEmitter {
  intentAtKill: Record<string, unknown> | null = null;

  constructor(
    readonly pid: number,
    readonly port: number,
    private readonly butlerData: string,
    private readonly onKilled: (child: FakeChild) => void,
  ) {
    super();
  }

  kill(signal: string) {
    if (signal === "SIGTERM") {
      const path = agentStopIntentPath(this.butlerData);
      this.intentAtKill = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
    }
    queueMicrotask(() => {
      this.onKilled(this);
      this.emit("exit", null, signal);
    });
    return true;
  }
}

async function flush() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}
