// test-category: race
import { expect, spyOn, test } from "bun:test";
import { watchAppUserWork } from "../../packages/butler-app/client/electron/app-user-work-events.mjs";

test("work stream backs off failures, caps retries, resets on connection and cancels on stop", async () => {
  const timers = new Map();
  let timerId = 0, attempts = 0, connected = 0, changes = 0, controller;
  const schedule = spyOn(globalThis, "setTimeout").mockImplementation((callback, delay) => {
    const id = ++timerId;
    timers.set(id, { callback, delay });
    return id;
  });
  const cancel = spyOn(globalThis, "clearTimeout").mockImplementation(id => { timers.delete(id); });
  // Drain only microtasks: the fake stream and connect calls never use timers.
  const settle = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
  const fire = async delay => {
    const entry = [...timers].find(([, timer]) => timer.delay === delay);
    expect(entry).toBeDefined();
    timers.delete(entry[0]);
    entry[1].callback();
    await settle();
  };
  const signalList = [];
  const stop = watchAppUserWork({
    connect: async signal => {
      signalList.push(signal);
      if (++attempts !== 8) throw new Error("unreachable");
      return new Response(new ReadableStream({ start(value) { controller = value; } }));
    },
    onConnected: () => { connected++; }, onChange: () => { changes++; },
  });
  try {
    await settle();
    for (const delay of [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]) await fire(delay);
    expect(attempts).toBe(8);
    expect(connected).toBe(1);
    await fire(100);
    expect(changes).toBe(1);
    controller.enqueue(new TextEncoder().encode("event: heartbeat\ndata: {}\n\n"));
    await settle();
    expect(timers.size).toBe(0);
    for (const type of ["turn.updated", "stream.reconcile_required"]) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type })}\n\n`));
    }
    await settle();
    expect(timers.size).toBe(1);
    await fire(100);
    expect(changes).toBe(2);
    controller.close();
    await settle();
    await fire(1000);
    expect(attempts).toBe(9);
    expect([...timers.values()].map(timer => timer.delay)).toEqual([2000]);
    stop();
    expect(timers.size).toBe(0);
    expect(signalList.every(signal => signal.aborted)).toBe(true);
  } finally { stop(); schedule.mockRestore(); cancel.mockRestore(); }
});
