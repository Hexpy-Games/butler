// test-category: race
import { test, expect } from "bun:test";
import { mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const { createStillOutbox } = createRequire(import.meta.url)("../../packages/butler-app/client/electron/browser/still-outbox.mjs");
const frame = (id: string, count = 1) => ({ id, session: "s", tab: "t", args: { steps: Array.from({ length: count }, () => ({})) } });
const pixels = (step = 0) => ({ step, still: { mime: "image/jpeg", base64: "YWJj" } });
async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "outbox-contract-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
test("409 is a final acknowledgement and more than 37 ten-step acts remain admissible", () => fixture(async directory => {
  const queue = createStillOutbox({ directory, retryMs: [], send: async () => { throw Object.assign(Error("still_settled"), { status: 409 }); } });
  try {
    for (let act = 0; act < 40; act++) {
      await queue.reserve(frame(String(act), 10));
      for (let step = 0; step < 10; step++) await queue.deliver(String(act), pixels(step));
      await queue.flush();
      expect(queue.records.size).toBe(0);
    }
    expect(await readdir(directory)).toEqual([]);
  } finally { queue.stop(); }
}));
test("corrupt records are quarantined with a bound and stale temporary files are removed", () => fixture(async directory => {
  for (let index = 0; index < 20; index++) await writeFile(join(directory, index.toString(16).padStart(64, "0") + ".json"), "broken");
  await writeFile(join(directory, "a".repeat(64) + ".json.tmp"), "incomplete");
  const queue = createStillOutbox({ directory, send: async () => {}, retryMs: [] });
  try {
    await queue.reserve(frame("new"));
    const names = await readdir(directory);
    expect(names.filter(name => name.endsWith(".corrupt")).length).toBeGreaterThan(0);
    expect(names.filter(name => name.endsWith(".corrupt")).length).toBeLessThanOrEqual(8);
    expect(names.some(name => name.endsWith(".tmp"))).toBe(false);
  } finally { queue.stop(); }
}));
test("finish sends explicit reasons for every never-run step", () => fixture(async directory => {
  const received: any[] = [];
  const queue = createStillOutbox({ directory, send: async (value: any) => { received.push(value); }, retryMs: [] });
  try {
    await queue.reserve(frame("act", 3));
    await queue.finish("act", { status: "unknown", reason: "browser_host_lost" });
    await queue.flush();
    expect(received.map(value => value.step)).toEqual([0, 1, 2]);
    expect(received.every(value => value.reason === "browser_host_lost")).toBe(true);
  } finally { queue.stop(); }
}));
test("a retired hidden host's complete queue replays in the App", () => fixture(async directory => {
  const hidden = createStillOutbox({ directory, send: async () => { throw Error("offline"); }, retryMs: [] });
  await hidden.reserve(frame("active", 3));
  for (let step = 0; step < 3; step++) await hidden.deliver("active", pixels(step));
  await hidden.flush(); hidden.stop();
  const received: any[] = [];
  // The App outbox owns its normal directory and recovers the retired host's directory.
  const app = createStillOutbox({ directory: join(directory, "app"), replayDirectories: [directory], send: async (value: any) => { received.push(value); }, retryMs: [] });
  try {
    await app.connect();
    expect(received.map(value => value.step)).toEqual([0, 1, 2]);
    expect(received.every(value => value.still.base64 === "YWJj")).toBe(true);
    expect((await readdir(directory)).filter(name => name.endsWith(".json"))).toEqual([]);
  } finally { app.stop(); }
}));

test("one failed entry's backoff does not hold newer evidence", () => fixture(async directory => {
  const received: string[] = [];
  const queue = createStillOutbox({ directory, retryMs: [4000], send: async (value: any) => {
    if (value.act_id === "old") throw Error("offline"); received.push(value.act_id);
  } });
  try {
    await queue.reserve(frame("old")); await queue.deliver("old", pixels()); await queue.flush();
    await queue.reserve(frame("new")); await queue.deliver("new", pixels()); await queue.flush();
    expect(received).toEqual(["new"]);
  } finally { queue.stop(); }
}));
test("a torn last append preserves every earlier durable JPEG", () => fixture(async directory => {
  const queue = createStillOutbox({ directory, retryMs: [], send: async () => { throw Error("offline"); } });
  await queue.reserve(frame("act", 3));
  for (let step = 0; step < 2; step++) await queue.deliver("act", pixels(step));
  await queue.flush(); queue.stop();
  const path = join(directory, (await readdir(directory))[0]!);
  await writeFile(path, (await readFile(path, "utf8")) + '{"step":2');
  const received: any[] = [];
  const replay = createStillOutbox({ directory, retryMs: [], send: async (value: any) => { received.push(value); } });
  try {
    await replay.connect();
    expect(received.map(value => value.step)).toEqual([0, 1, 2]);
    expect(received.slice(0, 2).every(value => value.still.base64 === "YWJj")).toBe(true);
    expect(received[2].reason).toBe("pixels_not_captured");
  } finally { replay.stop(); }
}));

for (const [status, code] of [[403, "browser_host_forbidden"], [429, "browser_busy"], [400, "invalid_json"], [409, "conflict"], [503, "still_settled"], [409, "still_upload_failed"], [400, "still_unknown"]] as const)
test(`HTTP ${status} ${code} retains pixels until reconnect`, () => fixture(async directory => {
  let online = false;
  const received: any[] = [];
  const queue = createStillOutbox({ directory, retryMs: [4000], send: async (value: any) => {
    if (!online) throw Object.assign(Error(code), { status }); received.push(value);
  } });
  try {
    await queue.reserve(frame("act")); await queue.deliver("act", pixels()); await queue.flush();
    expect(queue.pending).toBe(1);
    const record = JSON.parse((await readFile(join(directory, (await readdir(directory))[0]!), "utf8")).split("\n").filter(Boolean).at(-1)!);
    expect(record.still.base64).toBe("YWJj");
    const entry = queue.records.get("act").entries[0];
    expect(entry.retryAt - Date.now()).toBeGreaterThan(0);
    expect(entry.retryAt - Date.now()).toBeLessThanOrEqual(4000);
    online = true; await queue.connect();
    expect(received[0].still.base64).toBe("YWJj"); expect(queue.pending).toBe(0);
  } finally { queue.stop(); }
}));

for (const status of [400, 409]) test(`HTTP ${status} still outcome is final`, () => fixture(async directory => {
  const queue = createStillOutbox({ directory, retryMs: [], send: async () => { throw Object.assign(Error("still_settled"), { status }); } });
  try {
    await queue.reserve(frame("act")); await queue.deliver("act", pixels()); await queue.flush();
    expect(queue.pending).toBe(0); expect(await readdir(directory)).toEqual([]);
  } finally { queue.stop(); }
}));
