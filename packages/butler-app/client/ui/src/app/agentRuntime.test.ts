/// <reference types="bun" />

import { expect, test } from "bun:test";
import {
  agentNotice,
  agentRuntimeState,
  readAgentRuntimeState,
  startAgent,
  subscribeAgentRuntimeState,
} from "./agentRuntime.ts";

test("agent runtime state parses bridge payloads defensively", () => {
  for (const state of ["running", "starting", "stopped", "restarting", "restart_failed", "failed"] as const) {
    expect(agentRuntimeState({ state })).toBe(state);
  }
  for (const value of [undefined, null, "stopped", { state: "sleeping" }, { state: 3 }, []]) {
    expect(agentRuntimeState(value)).toBe("unknown");
  }
});

test("an intentional stop, an external restart, and its failure need a notice", () => {
  expect(agentNotice("stopped")).toBe("stopped");
  expect(agentNotice("restarting")).toBe("restarting");
  expect(agentNotice("restart_failed")).toBe("restart_failed");
  for (const state of ["running", "starting", "failed", "unknown"] as const) {
    expect(agentNotice(state)).toBeNull();
  }
});

test("bridge helpers read, subscribe, and start through window.butlerApp", async () => {
  const previous = globalThis.window;
  const listeners: Array<(value: unknown) => void> = [];
  let started = 0;
  Object.assign(globalThis, {
    window: {
      butlerApp: {
        getAgentState: async () => ({ state: "stopped" }),
        startAgent: async () => {
          started += 1;
          return { state: "running" };
        },
        onAgentState: (handler: (value: unknown) => void) => {
          listeners.push(handler);
          return () => listeners.splice(listeners.indexOf(handler), 1);
        },
      },
    },
  });
  try {
    expect(await readAgentRuntimeState()).toBe("stopped");
    const seen: string[] = [];
    const unsubscribe = subscribeAgentRuntimeState((state) => seen.push(state));
    listeners[0]?.({ state: "running" });
    unsubscribe();
    expect(listeners).toHaveLength(0);
    expect(seen).toEqual(["running"]);
    expect(await startAgent()).toBe("running");
    expect(started).toBe(1);
  } finally {
    Object.assign(globalThis, { window: previous });
  }
});

test("bridge helpers are inert without the desktop bridge", async () => {
  const previous = globalThis.window;
  Object.assign(globalThis, { window: {} });
  try {
    expect(await readAgentRuntimeState()).toBe("unknown");
    expect(typeof subscribeAgentRuntimeState(() => undefined)).toBe("function");
    await expect(startAgent()).rejects.toThrow();
  } finally {
    Object.assign(globalThis, { window: previous });
  }
});
