import { expect, test } from "bun:test";
import type { ByteReader, GatewayClient } from "./gateway.ts";
import { connectLive } from "./live.ts";
import type { LiveEvent } from "./live.ts";

// test-category: pure-logic
test("live events resume from the cursor and reconcile after recovery", async () => {
  const cursors: number[] = [], events: LiveEvent[] = [];
  let lost = false, reconciles = 0, recovered = 0;
  let reportLoss!: () => void, reportReconcile!: () => void;
  const loss = new Promise<void>(resolve => { reportLoss = resolve; });
  const reconcile = new Promise<void>(resolve => { reportReconcile = resolve; });
  const client: GatewayClient = {
    async request<T>() { return undefined as T; },
    async openLiveEvents(cursor) {
      cursors.push(cursor);
      const first = cursors.length === 1;
      let delivered = false;
      let finish: ((chunk: { done: boolean }) => void) | undefined;
      const reader: ByteReader = {
        async read() {
          if (!delivered) {
            delivered = true;
            const data = first
              ? 'id: 5\ndata: {"id":5,"type":"message"}\n\nid: 6\ndata: {"id":6,"type":"message"}\n\n'
              : 'id: 300\ndata: {"id":300,"type":"stream.reconcile_required"}\n\n';
            return { done: false, value: new TextEncoder().encode(data) };
          }
          if (first) return { done: true };
          return new Promise<{ done: boolean }>(resolve => { finish = resolve; });
        },
        async cancel() { finish?.({ done: true }); },
      };
      return { status: 200, ok: true, body: { getReader: () => reader }, json: async () => null };
    },
  };
  const connection = connectLive({
    client, cursor: 0,
    onEvent: event => { events.push(event); },
    onReconcile: () => { reconciles++; reportReconcile(); },
    onRecovered: () => { recovered++; },
    onLostChange: value => { lost = value; if (value && events.length === 2) reportLoss(); },
  });
  try {
    await loss;
    expect(events).toEqual([{ id: 5, type: "message" }, { id: 6, type: "message" }]);
    expect(lost).toBe(true);
    connection.resume();
    expect(cursors).toEqual([0, 6]);
    await reconcile;
    expect(reconciles).toBe(1);
    expect(recovered).toBe(1);
    expect(connection.cursor).toBe(300);
    connection.close();
    await Promise.resolve();
    expect(cursors).toEqual([0, 6]);
  } finally {
    connection.close();
  }
});
