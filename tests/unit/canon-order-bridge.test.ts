// test-category: security
import { afterEach, expect, test } from "bun:test";
import { api } from "../../packages/butler-app/client/ui/src/app/api.ts";
import { canonBridgeInput } from "../../packages/butler-app/client/ui/src/app/canonBridge.ts";
import { beginCanonQueueEdit, canonQueueSnapshot, observeCanonQueue, publishCanonQueueEvent } from "../../packages/butler-app/client/ui/src/app/canonQueue.ts";
import type { CanonQueueView } from "../../packages/butler-app/client/shared/canon-queue-contracts.ts";
import type { TimelineEvent } from "../../packages/butler-app/client/ui/src/app/types.ts";

const previous = globalThis.window;
afterEach(() => Object.assign(globalThis, { window: previous }));
function bridge(methods: Record<string, unknown>) {
  Object.assign(globalThis, { window: { location: { origin: "http://localhost" }, butlerApp: methods } });
}
const view = (revision: number): CanonQueueView => ({ session_id: "session", graph_revision: revision, plan: null,
  counts: { running: 0, failed: 0, held: 0, waiting: 1 }, chains: [{ chain_id: "chain", origin: "user_message", steps: [{ index: 0, items: [{
    epic_id: "epic", title: "Title", state: "waiting", canon_status: "planned",
    progress: { epic_id: "epic", running: false, stage: null, stage_history: [], actions: [], disposition: null, counts: { completed: 0, total: 0 } },
  }] }] }] });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function event(type: string, payload?: Record<string, unknown>) { publishCanonQueueEvent({ type, payload } as TimelineEvent); }

test("canon order routes preserve ordered selections and reject extra route segments and verbs", () => {
  const input = { expected_graph_revision: 4, op: "move_between", epic_ids: ["b", "a"], target_chain_id: "other", index: 1 };
  for (const [verb, tail, method] of [["GET", "", "getCanonQueue"], ["POST", "/edits", "editCanonQueue"],
    ["POST", "/holds/epic%2Fid", "decideCanonHold"], ["POST", "/take/epic%2Fid", "takeCanonHere"]]) {
    const route = canonBridgeInput(new URL(`http://localhost/sessions/chat%2Fid/canon/queue${tail}`), verb, () => input);
    expect(route).toEqual({ method, input: { sessionId: "chat/id", epicId: tail.includes("epic") ? "epic/id" : undefined, body: input } });
    expect(canonBridgeInput(new URL(`http://localhost/sessions/chat/canon/queue${tail}/extra`), verb, () => input)).toBeNull();
  }
  for (const tail of ["", "/edits", "/holds/epic", "/take/epic"]) {
    expect(canonBridgeInput(new URL(`http://localhost/sessions/chat/canon/queue${tail}`), "DELETE", () => input)).toBeNull();
  }
});

test("desktop order conflicts retain HTTP status even without an error envelope from the gateway", async () => {
  bridge({ editCanonQueue: async () => ({ ok: false, error: { schema: "butler.app.bridge-error.v1", code: "request_failed", status: 409 } }) });
  const error = await api("/sessions/session/canon/queue/edits", { method: "POST", body: JSON.stringify({ expected_graph_revision: 1, op: "delete", epic_id: "epic" }) }).catch((error: unknown) => error);
  expect((error as { status: number }).status).toBe(409);
});

// test-category: race
test("shared demand reader coalesces newer revisions and progress, and stops reading after disposal", async () => {
  let reads = 0;
  bridge({ getCanonQueue: async () => { reads++; return { ok: true, data: view(reads) }; } });
  const off = observeCanonQueue("session", () => {});
  const other = observeCanonQueue("session", () => {});
  try {
    await flush(); expect(reads).toBe(1);
    event("canon.queue_changed", { session_id: "session", graph_revision: 1 });
    event("canon.progress_changed", { epic_id: "unrelated" });
    await flush(); expect(reads).toBe(1);
    event("canon.queue_changed", { session_id: "session", graph_revision: 3 });
    event("canon.progress_changed", { epic_id: "epic" });
    await flush(); expect(reads).toBe(2);
    event("stream.reconcile_required"); await flush(); expect(reads).toBe(3);
  } finally { off(); other(); }
  event("stream.reconcile_required"); await flush(); expect(reads).toBe(3);
});

// test-category: race
test("an edit excludes a second writer and an old fetch cannot replace its optimistic snapshot", async () => {
  let resolve!: (value: unknown) => void;
  let reads = 0;
  bridge({ getCanonQueue: () => { reads++; return new Promise(done => { resolve = done; }); } });
  const off = observeCanonQueue("session", () => {});
  try {
    await flush();
    const finish = beginCanonQueueEdit("session", view(4))!;
    expect(beginCanonQueueEdit("session", view(5))).toBeNull();
    resolve({ ok: true, data: view(1) }); await flush();
    expect(canonQueueSnapshot("session").view?.graph_revision).toBe(4);
    event("canon.queue_changed", { session_id: "session", graph_revision: 7 });
    await flush(); expect(reads).toBe(1);
    finish(view(5)); await flush(); expect(reads).toBe(2);
    resolve({ ok: true, data: view(7) }); await flush();
    expect(canonQueueSnapshot("session")).toEqual({ view: view(7), busy: false });
  } finally { off(); }
});

// test-category: race
test("completion from an unmounted reader cannot overwrite its replacement", async () => {
  bridge({ getCanonQueue: async () => ({ ok: true, data: view(8) }) });
  const off = observeCanonQueue("session", () => {});
  await flush();
  const finish = beginCanonQueueEdit("session", view(9))!;
  off();
  const replacement = observeCanonQueue("session", () => {});
  try {
    await flush(); finish(view(10));
    expect(canonQueueSnapshot("session").view?.graph_revision).toBe(8);
  } finally { replacement(); }
});

// test-category: race
test("progress during a fetch has one trailing read and preserves the final complete state", async () => {
  let reads = 0;
  let active = 0;
  let maximum = 0;
  const pending: Array<(revision: number) => void> = [];
  bridge({ getCanonQueue: () => {
    reads++; maximum = Math.max(maximum, ++active);
    return new Promise(done => pending.push(revision => { active--; done({ ok: true, data: view(revision) }); }));
  } });
  const off = observeCanonQueue("session", () => {});
  try {
    await flush(); pending.shift()!(1); await flush();
    event("canon.progress_changed", { epic_id: "epic" }); await flush();
    for (let i = 0; i < 20; i++) { event("canon.progress_changed", { epic_id: "epic" }); await flush(); }
    expect(reads).toBe(2); expect(maximum).toBe(1);
    pending.shift()!(2); await flush();
    expect(reads).toBe(3); expect(maximum).toBe(1);
    pending.shift()!(3); await flush();
    expect(canonQueueSnapshot("session")).toEqual({ view: view(3), busy: false });
    expect(reads).toBe(3);
  } finally { off(); for (const finish of pending) finish(3); await flush(); }
});
