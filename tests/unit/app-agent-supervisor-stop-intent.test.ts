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
  AGENT_STOP_DRAIN_EXIT_MS,
  AGENT_STOP_KILL_TIMEOUT_MS,
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

  h.exitChild(child, 0, null);
  await flush();

  expect(h.events.unexpected).toBe(0);
  expect(h.events.intentional).toEqual([
    { reason: "stop", requestedBy: "cli", respawnBy: null },
  ]);
  expect(h.supervisor.agentState()).toMatchObject({ state: "stopped", requested_by: "cli" });
  await expect(h.supervisor.ensureReady()).rejects.toMatchObject({ code: "agent_stopped" });
  expect(h.spawned).toHaveLength(1);
});

test("start from the stopped state ignores the leftover intent and spawns normally", async () => {
  const h = createHarness();
  await h.supervisor.ensureReady();
  const first = h.spawned[0]!;
  h.writeIntent({ reason: "stop", pid: first.pid, instance_id: `nonce-${first.pid}` });
  h.exitChild(first, 0, null);
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

test("a CLI or MCP restart of the App's child (respawn_by app) respawns it right away", async () => {
  for (const requestedBy of ["cli", "mcp"] as const) {
    const h = createHarness();
    await h.supervisor.ensureReady();
    const child = h.spawned[0]!;
    h.writeIntent({
      reason: "restart",
      requested_by: requestedBy,
      respawn_by: "app",
      pid: child.pid,
      instance_id: `nonce-${child.pid}`,
    });

    h.exitChild(child, 0, null);
    expect(h.supervisor.agentState().state).toBe("restarting");
    // The supervisor respawns by itself; nobody calls ensureReady.
    await settle(() => h.spawned.length === 2 && h.supervisor.agentState().state === "running");
    await h.supervisor.ensureReady();

    expect(h.spawned).toHaveLength(2);
    expect(h.clock()).toBe(0);
    expect(h.events.unexpected).toBe(0);
    expect(h.events.attached).toEqual([]);
    expect(h.events.intentional).toEqual([{ reason: "restart", requestedBy, respawnBy: "app" }]);
    expect(h.supervisor.agentState().state).toBe("running");
    expect(h.supervisor.diagnostics()).toMatchObject({
      pid: h.spawned[1]!.pid,
      external_agent_attached: false,
    });
    // The replacement is the App's own child, with the App's environment.
    expect(h.spawned[1]!.env).toMatchObject({
      BUTLER_APP_BUNDLED_SUPERVISOR: "1",
      BUTLER_APP_LOCAL_AUTH_REQUIRED: "1",
      BUTLER_APP_LOCAL_AUTH_FILE: appLocalAuthPath(h.butlerData),
      BUTLER_APP_SERVER_PORT: String(h.port()),
    });
  }
});

test("the App's replacement is itself restartable by the next CLI restart", async () => {
  const h = createHarness();
  await h.supervisor.ensureReady();
  for (let round = 0; round < 3; round += 1) {
    const current = h.spawned[round]!;
    h.writeIntent({
      reason: "restart",
      respawn_by: "app",
      pid: current.pid,
      instance_id: `nonce-${current.pid}`,
    });
    h.exitChild(current, 0, null);
    await settle(() => h.spawned.length === round + 2 &&
      h.supervisor.agentState().state === "running");
  }
  expect(h.spawned).toHaveLength(4);
  expect(h.events.unexpected).toBe(0);
});

test("a restart with respawn_by controller waits for the new instance and reconnects", async () => {
  const h = createHarness();
  await h.supervisor.ensureReady();
  const child = h.spawned[0]!;
  h.writeIntent({
    reason: "restart",
    respawn_by: "controller",
    pid: child.pid,
    instance_id: `nonce-${child.pid}`,
  });
  h.onSleep = () => {
    if (h.clock() >= 1_000) h.startExternalInstance({ pid: 7300, port: 18801 });
  };

  h.exitChild(child, 0, null);
  expect(h.supervisor.agentState().state).toBe("restarting");
  await h.supervisor.ensureReady();
  await flush();

  expect(h.spawned).toHaveLength(1);
  expect(h.events.unexpected).toBe(0);
  expect(h.events.intentional).toEqual([
    { reason: "restart", requestedBy: "cli", respawnBy: "controller" },
  ]);
  expect(h.events.attached).toEqual([
    { pid: 7300, instanceId: "nonce-7300", port: 18801, appSupervised: false },
  ]);
  // The attach event is what the App publishes to windows: it must already
  // report running, or the Restarting notice would stay up.
  expect(h.events.stateAtAttach).toEqual(["running"]);
  expect(h.port()).toBe(18801);
  expect(h.supervisor.agentState().state).toBe("running");
});

test("a restart with respawn_by null or missing is treated as controller", async () => {
  for (const respawnBy of [null, undefined]) {
    const h = createHarness();
    await h.supervisor.ensureReady();
    const child = h.spawned[0]!;
    h.writeIntent({
      reason: "restart",
      respawn_by: respawnBy,
      pid: child.pid,
      instance_id: `nonce-${child.pid}`,
    });
    h.onSleep = () => {
      if (h.clock() >= 500) h.startExternalInstance({ pid: 7310, port: 18803 });
    };

    h.exitChild(child, 0, null);
    await h.supervisor.ensureReady();
    await flush();

    expect(h.spawned).toHaveLength(1);
    expect(h.events.intentional).toEqual([
      { reason: "restart", requestedBy: "cli", respawnBy: "controller" },
    ]);
    expect(h.events.attached.map((event) => event.pid)).toEqual([7310]);
  }
});

test("a restart that never produces a new instance times out into a recoverable error", async () => {
  const h = createHarness({ restartReconnectTimeoutMs: 5_000 });
  await h.supervisor.ensureReady();
  const child = h.spawned[0]!;
  h.writeIntent({
    reason: "restart",
    respawn_by: "controller",
    pid: child.pid,
    instance_id: `nonce-${child.pid}`,
  });

  h.exitChild(child, 0, null);
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

test("an attached Agent leased by another App (respawn_by app) is replaced by that App", async () => {
  const h = createHarness();
  h.startExternalInstance({ pid: 7500, port: 18765, appSupervised: true });
  await h.supervisor.ensureReady();
  expect(h.events.attached).toEqual([
    { pid: 7500, instanceId: "nonce-7500", port: 18765, appSupervised: true },
  ]);
  h.writeIntent({
    reason: "restart",
    respawn_by: "app",
    pid: 7500,
    instance_id: "nonce-7500",
  });
  h.stopExternalInstance(7500);
  h.onSleep = () => {
    if (h.clock() >= 1_000) {
      h.startExternalInstance({ pid: 7501, port: 18765, appSupervised: true });
    }
  };

  await h.runPolls();
  expect(h.supervisor.agentState().state).toBe("restarting");
  await h.supervisor.ensureReady();
  await flush();

  expect(h.spawned).toHaveLength(0);
  expect(h.events.unexpected).toBe(0);
  expect(h.events.intentional).toEqual([
    { reason: "restart", requestedBy: "cli", respawnBy: "app" },
  ]);
  expect(h.events.attached.map((event) => event.pid)).toEqual([7500, 7501]);
});

test("an unrequested self-exit (exit 1, no intent) takes the crash recovery path", async () => {
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

test("a SIGKILL or a crash without an intent takes the crash recovery path", async () => {
  const h = createHarness();
  await h.supervisor.ensureReady();

  h.exitChild(h.spawned[0]!, null, "SIGKILL");
  await flush();

  expect(h.events.unexpected).toBe(1);
  expect(h.events.intentional).toEqual([]);
});

test("an exit 1 while an intent names another instance is a crash", async () => {
  const h = createHarness();
  await h.supervisor.ensureReady();
  h.writeIntent({ reason: "stop", pid: 1234, instance_id: "nonce-1234" });

  h.exitChild(h.spawned[0]!, 1, null);
  await flush();

  expect(h.events.unexpected).toBe(1);
});

test("an external stop that drains for 6 s and exits 0 by itself stays stopped", async () => {
  const h = createHarness();
  await h.supervisor.ensureReady();
  const child = h.spawned[0]!;
  h.writeIntent({ reason: "stop", pid: child.pid, instance_id: `nonce-${child.pid}` });

  await h.advance(AGENT_STOP_DRAIN_EXIT_MS);
  h.exitChild(child, 0, null);
  await flush();

  expect(h.events.unexpected).toBe(0);
  expect(h.supervisor.agentState().state).toBe("stopped");
});

test("an external stop that the controller SIGKILLs after 8 s still stays stopped", async () => {
  const h = createHarness();
  await h.supervisor.ensureReady();
  const child = h.spawned[0]!;
  h.writeIntent({ reason: "stop", pid: child.pid, instance_id: `nonce-${child.pid}` });

  h.exitChild(child, null, "SIGKILL");
  await flush();

  expect(h.events.unexpected).toBe(0);
  expect(h.supervisor.agentState().state).toBe("stopped");
});

test("the App's own stop waits 8 s before SIGKILL, so the Agent's 6 s self-exit lands first", async () => {
  const h = createHarness();
  await h.supervisor.ensureReady();
  const child = h.spawned[0]!;
  child.stallOnTerm = true;

  const stopping = h.supervisor.stop({ wait: true });
  expect(h.killTimers.map((timer) => timer.ms)).toEqual([AGENT_STOP_KILL_TIMEOUT_MS]);
  await h.advance(AGENT_STOP_DRAIN_EXIT_MS);
  h.exitChild(child, 0, null);
  await stopping;

  expect(child.signals).toEqual(["SIGTERM"]);
  expect(h.killTimers[0]!.cleared).toBe(true);
  expect(h.events.unexpected).toBe(0);
});

test("the intent must name both the exited nonce and pid", async () => {
  const pidMismatch = createHarness();
  await pidMismatch.supervisor.ensureReady();
  pidMismatch.writeIntent({ reason: "stop", pid: 1234, instance_id: "nonce-9100" });
  pidMismatch.exitChild(pidMismatch.spawned[0]!, 0, null);
  await flush();
  expect(pidMismatch.events.unexpected).toBe(1);
  expect(pidMismatch.supervisor.agentState().state).not.toBe("stopped");

  const nonceMismatch = createHarness();
  await nonceMismatch.supervisor.ensureReady();
  nonceMismatch.writeIntent({ reason: "stop", pid: 9100, instance_id: "nonce-other" });
  nonceMismatch.exitChild(nonceMismatch.spawned[0]!, 0, null);
  await flush();
  expect(nonceMismatch.events.unexpected).toBe(1);
  expect(nonceMismatch.supervisor.agentState().state).not.toBe("stopped");
});

test("a child that never published its instance nonce exits as a crash", async () => {
  const h = createHarness({ publishChildRecord: false });
  await h.supervisor.ensureReady();
  h.writeIntent({ reason: "stop", pid: 9100, instance_id: "nonce-9100" });
  h.exitChild(h.spawned[0]!, 0, null);
  await flush();
  expect(h.events.unexpected).toBe(1);
});

test("the nonce is learned while the child starts, so a stop during startup is honored", async () => {
  const h = createHarness({ childServes: () => false });
  h.onSleep = () => {
    const child = h.spawned[0]!;
    if (!child.exited) {
      h.writeIntent({ reason: "stop", pid: child.pid, instance_id: `nonce-${child.pid}` });
      h.removeRecord();
      h.exitChild(child, 0, null);
    }
  };

  await expect(h.supervisor.ensureReady()).rejects.toMatchObject({ code: "agent_stopped" });
  await flush();

  expect(h.events.unexpected).toBe(0);
  expect(h.supervisor.agentState().state).toBe("stopped");
  expect(h.spawned).toHaveLength(1);
});

test("a restart (respawn_by app) during startup hands the caller the replacement", async () => {
  const h = createHarness({ childServes: (index) => index > 0 });
  h.onSleep = () => {
    const child = h.spawned[0]!;
    if (!child.exited) {
      h.writeIntent({
        reason: "restart",
        respawn_by: "app",
        pid: child.pid,
        instance_id: `nonce-${child.pid}`,
      });
      h.removeRecord();
      h.exitChild(child, 0, null);
    }
  };

  await h.supervisor.ensureReady();
  await flush();

  expect(h.spawned).toHaveLength(2);
  expect(h.events.unexpected).toBe(0);
  expect(h.supervisor.agentState().state).toBe("running");
});

test("reconnecting to an external instance uses the token in the shared auth file", async () => {
  const h = createHarness();
  await h.supervisor.ensureReady();
  const child = h.spawned[0]!;
  h.writeIntent({
    reason: "restart",
    respawn_by: "controller",
    pid: child.pid,
    instance_id: `nonce-${child.pid}`,
  });
  const sharedToken = "s".repeat(43);
  h.onSleep = () => {
    if (h.clock() < 1_000) return;
    writeFileSync(appLocalAuthPath(h.butlerData), JSON.stringify({
      schema: "butler.app-local-agent-auth.v1",
      token: sharedToken,
    }));
    h.startExternalInstance({ pid: 7700, port: 18802 });
  };

  h.exitChild(child, 0, null);
  await h.supervisor.ensureReady();

  expect(h.healthTokens.get(18802)).toEqual([sharedToken]);
  expect(h.supervisor.authHeaders()).toEqual({ authorization: `Bearer ${sharedToken}` });
});

test("a malformed intent or an unknown respawn_by is treated as a crash", async () => {
  for (const content of [
    "{\"schema\":\"butler.agent-stop-intent.v1\"",
    JSON.stringify({
      schema: "butler.agent-stop-intent.v1",
      reason: "restart",
      requested_by: "cli",
      respawn_by: "launchd",
      instance_id: "nonce-9100",
      pid: 9100,
      requested_at: "2026-09-27T10:00:00Z",
    }),
  ]) {
    const h = createHarness();
    await h.supervisor.ensureReady();
    mkdirSync(dirname(agentStopIntentPath(h.butlerData)), { recursive: true });
    writeFileSync(agentStopIntentPath(h.butlerData), content);

    h.exitChild(h.spawned[0]!, 0, null);
    await flush();

    expect(h.events.unexpected).toBe(1);
    expect(h.events.intentional).toEqual([]);
  }
});

test("while stopped, an externally started agent is detected and attached", async () => {
  const h = createHarness();
  await h.supervisor.ensureReady();
  const child = h.spawned[0]!;
  h.writeIntent({ reason: "stop", pid: child.pid, instance_id: `nonce-${child.pid}` });
  h.exitChild(child, 0, null);
  await flush();

  await h.runPolls();
  expect(h.supervisor.agentState().state).toBe("stopped");

  h.startExternalInstance({ pid: 7400, port: 18765 });
  await h.runPolls();
  await flush();

  expect(h.supervisor.agentState().state).toBe("running");
  expect(h.events.attached).toEqual([
    { pid: 7400, instanceId: "nonce-7400", port: 18765, appSupervised: false },
  ]);
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

test("an app stop records a stop intent (respawn_by null) before SIGTERM, never recovery", async () => {
  const h = createHarness();
  await h.supervisor.ensureReady();
  const child = h.spawned[0]!;

  await h.supervisor.stop({ wait: true });

  expect(child.intentAtKill).toMatchObject({
    schema: "butler.agent-stop-intent.v1",
    reason: "stop",
    requested_by: "app",
    respawn_by: null,
    pid: child.pid,
    instance_id: `nonce-${child.pid}`,
  });
  expect(h.events.unexpected).toBe(0);
  expect(h.events.intentional).toEqual([]);
});

test("an app restart records restart with respawn_by app and clears a stopped state", async () => {
  const h = createHarness();
  await h.supervisor.ensureReady();
  const first = h.spawned[0]!;

  await h.supervisor.restart();

  expect(first.intentAtKill).toMatchObject({
    reason: "restart",
    requested_by: "app",
    respawn_by: "app",
  });
  expect(h.spawned).toHaveLength(2);

  const second = h.spawned[1]!;
  h.writeIntent({ reason: "stop", pid: second.pid, instance_id: `nonce-${second.pid}` });
  h.exitChild(second, 0, null);
  await flush();
  expect(h.supervisor.agentState().state).toBe("stopped");

  await h.supervisor.restart();
  expect(h.spawned).toHaveLength(3);
  expect(h.supervisor.agentState().state).toBe("running");
});

test("an app repair records restart with respawn_by app", async () => {
  const h = createHarness();
  await h.supervisor.ensureReady();
  const first = h.spawned[0]!;

  await h.supervisor.repair();

  expect(first.intentAtKill).toMatchObject({
    reason: "restart",
    requested_by: "app",
    respawn_by: "app",
  });
  expect(h.spawned).toHaveLength(2);
});

test("an app intent is retracted when SIGTERM cannot be delivered", async () => {
  const h = createHarness();
  await h.supervisor.ensureReady();
  const child = h.spawned[0]!;
  child.deliverSignals = false;

  await h.supervisor.stop();

  expect(child.intentAtKill).toMatchObject({ reason: "stop", requested_by: "app" });
  expect(existsSync(agentStopIntentPath(h.butlerData))).toBe(false);
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
  childServes?: (index: number) => boolean;
} = {}) {
  const butlerData = join(root, `data-${Math.random().toString(36).slice(2)}`);
  const spawned: FakeChild[] = [];
  const alive = new Set<number>();
  const serving = new Set<number>();
  const polls = new Map<number, () => unknown>();
  const killTimers: Array<{ ms: number; cleared: boolean }> = [];
  let pollId = 0;
  let port = 18765;
  let clock = 0;
  const events = {
    unexpected: 0,
    restartFailed: 0,
    intentional: [] as Array<{
      reason: string;
      requestedBy: string | null;
      respawnBy: string | null;
    }>,
    attached: [] as Array<{
      pid: number;
      instanceId: string;
      port: number;
      appSupervised: boolean;
    }>,
    stateAtAttach: [] as string[],
  };
  const healthTokens = new Map<number, string[]>();
  const harness = {
    butlerData,
    spawned,
    events,
    healthTokens,
    killTimers,
    onSleep: () => {},
    clock: () => clock,
    port: () => port,
    supervisor: null as unknown as ReturnType<typeof createBundledAgentSupervisor>,
    async advance(ms: number) {
      clock += ms;
      await flush();
    },
    writeIntent(intent: Record<string, unknown>) {
      mkdirSync(dirname(agentStopIntentPath(butlerData)), { recursive: true });
      writeFileSync(agentStopIntentPath(butlerData), JSON.stringify({
        schema: "butler.agent-stop-intent.v1",
        requested_by: "cli",
        respawn_by: null,
        requested_at: "2026-09-27T10:00:00Z",
        ...intent,
      }));
    },
    removeRecord() {
      rmSync(nativeServiceInstancePath(butlerData), { force: true });
    },
    exitChild(child: FakeChild, code: number | null, signal: string | null) {
      alive.delete(child.pid);
      serving.delete(child.port);
      child.exited = true;
      child.emit("exit", code, signal);
    },
    startExternalInstance({ pid, port: externalPort, appSupervised = false }: {
      pid: number;
      port: number;
      appSupervised?: boolean;
    }) {
      alive.add(pid);
      serving.add(externalPort);
      writeRecord({ pid, port: externalPort, state: "ready", appSupervised });
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

  function writeRecord({ pid, port: recordPort, state, appSupervised }: {
    pid: number;
    port: number;
    state: string;
    appSupervised: boolean;
  }) {
    mkdirSync(dirname(nativeServiceInstancePath(butlerData)), { recursive: true });
    writeFileSync(nativeServiceInstancePath(butlerData), JSON.stringify({
      schema: "butler.native-agent-service-instance.v1",
      nonce: `nonce-${pid}`,
      pid,
      process_start: "start",
      executable: "/runtime/butler-agent",
      state,
      app_enabled: true,
      app_endpoint: `http://127.0.0.1:${recordPort}`,
      app_auth_required: true,
      app_supervised: appSupervised,
      ready_at: state === "ready" ? "2026-09-27T10:00:00Z" : null,
    }));
  }

  harness.supervisor = createBundledAgentSupervisor({
    butlerData,
    resolveGateway: () => ({
      command: "/runtime/butler-agent",
      args: ["service", "run"],
      env: {},
    }),
    spawnProcess: (_command, _args, spawnOptions) => {
      const index = spawned.length;
      const child = new FakeChild(9100 + index * 100, port, butlerData, (exited) => {
        alive.delete(exited.pid);
        serving.delete(exited.port);
        exited.exited = true;
      });
      child.env = spawnOptions.env;
      spawned.push(child);
      alive.add(child.pid);
      const serves = options.childServes?.(index) ?? true;
      if (serves) serving.add(port);
      if (options.publishChildRecord !== false) {
        writeRecord({
          pid: child.pid,
          port,
          state: serves ? "ready" : "starting",
          appSupervised: true,
        });
      }
      return child;
    },
    healthCheck: (localAuth, portOverride) => {
      const probePort = portOverride ?? port;
      if (serving.has(probePort) && localAuth?.token) {
        healthTokens.set(probePort, [...(healthTokens.get(probePort) ?? []), localAuth.token]);
      }
      return serving.has(probePort);
    },
    readinessCheck: (_localAuth, _gateway, portOverride) =>
      serving.has(portOverride ?? port),
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
    setKillTimer: (_fn, ms) => {
      const timer = { ms, cleared: false };
      killTimers.push(timer);
      return timer;
    },
    clearKillTimer: (timer) => {
      (timer as { cleared: boolean }).cleared = true;
    },
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
    onIntentionalExit: ({ reason, requestedBy, respawnBy }) => {
      events.intentional.push({ reason, requestedBy, respawnBy });
    },
    onExternalAttach: ({ pid, instanceId, port: attachedPort, appSupervised }) => {
      events.attached.push({ pid, instanceId, port: attachedPort, appSupervised });
      events.stateAtAttach.push(harness.supervisor.agentState().state);
    },
    onRestartReconnectFailed: () => {
      events.restartFailed += 1;
    },
  });
  return harness;
}

class FakeChild extends EventEmitter {
  intentAtKill: Record<string, unknown> | null = null;
  env: Record<string, string | undefined> = {};
  signals: string[] = [];
  exited = false;
  /** SIGTERM is accepted but the Agent keeps draining (exits later on its own). */
  stallOnTerm = false;
  /** kill() reports that the signal could not be delivered. */
  deliverSignals = true;

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
    if (!this.deliverSignals) return false;
    this.signals.push(signal);
    if (signal === "SIGTERM" && this.stallOnTerm) return true;
    queueMicrotask(() => {
      this.onKilled(this);
      // An intentional stop exits 0 (#244); SIGKILL ends the process by signal.
      if (signal === "SIGKILL") this.emit("exit", null, "SIGKILL");
      else this.emit("exit", 0, null);
    });
    return true;
  }
}

async function settle(done: () => boolean) {
  for (let turn = 0; turn < 50 && !done(); turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(done()).toBe(true);
}

async function flush() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}
