import { expect, test } from "bun:test";
import { createAppUpdateCoordinator, type AppUpdateState } from "../../packages/butler-app/client/electron/app-foreground-update.mjs";

function fixture(active = false) {
  const calls: string[] = [];
  const states: AppUpdateState[] = [];
  let wake = () => {};
  let work = active;
  let stopReady = true;
  const coordinator = createAppUpdateCoordinator({
    readActiveWork: async () => ({ classification: work ? "active_work_detected" : "no_active_work" }),
    watchWork: (onChange) => { wake = onChange; return () => calls.push("unwatch"); },
    stopForUpdate: async () => { calls.push("checkpoint"); return { update_ready: stopReady }; },
    onState: (state) => states.push(state),
  });
  const prepare = async () => {
    calls.push("prepare");
    return { activate: () => { calls.push("activate"); }, cancel: () => { calls.push("cancel"); } };
  };
  return { coordinator, prepare, calls, states, settle: () => { work = false; wake(); },
    startWork: () => { work = true; wake(); },
    failStop: () => { stopReady = false; } };
}

async function nextTick() { await new Promise(resolve => setTimeout(resolve, 0)); }

// test-category: pure-logic
test("idle update checkpoints and activates once without a choice", async () => {
  const f = fixture();
  const first = f.coordinator.request(f.prepare);
  const second = f.coordinator.request(f.prepare);
  expect(first).toBe(second);
  expect(await first).toEqual({ status: "update_started", update_started: true });
  expect(f.calls).toEqual(["prepare", "checkpoint", "activate"]);
  expect(f.states.some(s => s.status === "choice_required")).toBeFalse();
});

// test-category: race
test("update now accepts only its exact choice and checkpoints before activation", async () => {
  const f = fixture(true);
  const pending = f.coordinator.request(f.prepare);
  await nextTick();
  expect(f.coordinator.state().status).toBe("choice_required");
  expect(f.coordinator.choose({ request_id: "stale", action: "now" }).ok).toBeFalse();
  const request_id = f.coordinator.state().request_id;
  expect(f.coordinator.choose({ request_id, action: "now" }).ok).toBeTrue();
  expect(f.coordinator.choose({ request_id, action: "defer" }).ok).toBeFalse();
  expect((await pending).status).toBe("update_started");
  expect(f.calls).toEqual(["prepare", "checkpoint", "activate"]);
});

// test-category: race
test("deferred update stays visible and activates once when work settles", async () => {
  const f = fixture(true);
  const pending = f.coordinator.request(f.prepare);
  await nextTick();
  f.coordinator.choose({ request_id: f.coordinator.state().request_id, action: "defer" });
  expect((await pending).status).toBe("deferred");
  expect(f.calls).toEqual([]);
  expect((await f.coordinator.request(f.prepare)).status).toBe("deferred");
  f.settle(); f.settle();
  await nextTick();
  expect(f.calls).toEqual(["unwatch", "prepare", "checkpoint", "activate"]);
  expect(f.coordinator.state().status).toBe("restarting");
});

// test-category: race
test("settlement while choosing later cannot strand an update", async () => {
  const f = fixture(true);
  const pending = f.coordinator.request(f.prepare);
  await nextTick();
  f.settle();
  f.coordinator.choose({ request_id: f.coordinator.state().request_id, action: "defer" });
  await pending; await nextTick();
  expect(f.calls).toEqual(["unwatch", "prepare", "checkpoint", "activate"]);

  const r = fixture(true);
  let prepares = 0;
  const prepare = async () => {
    const helper = await r.prepare();
    if (++prepares === 1) r.startWork();
    return helper;
  };
  const deferred = r.coordinator.request(prepare);
  await nextTick();
  r.coordinator.choose({ request_id: r.coordinator.state().request_id, action: "defer" });
  await deferred;
  r.settle(); await nextTick();
  expect(r.coordinator.state().status).toBe("deferred");
  expect(r.calls).toEqual(["unwatch", "prepare", "cancel"]);
  r.settle(); await nextTick();
  expect(r.calls).toEqual(["unwatch", "prepare", "cancel", "unwatch", "prepare", "checkpoint", "activate"]);
});

// test-category: pure-logic
test("failed checkpoint cancels the helper, reports failure and never activates", async () => {
  const f = fixture();
  f.failStop();
  await expect(f.coordinator.request(f.prepare)).rejects.toThrow("update_checkpoint_failed");
  expect(f.calls).toEqual(["prepare", "checkpoint", "cancel"]);
  expect(f.coordinator.state().status).toBe("failed");
});
