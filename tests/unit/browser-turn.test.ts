// test-category: pure-logic
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitBrowserTurn } from "../support/browser-turn";

for (const state of ["failed", "cancelled", "runtime_fault"]) {
  test(`browser turn stops immediately on ${state} and preserves the error and latest events`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "browser-turn-"));
    const paths: string[] = [];
    const api = async <T>(path: string): Promise<T> => {
      paths.push(path);
      if (path.startsWith("/session-view")) return { latest_turn: { id:"new", state }, cursors:{ events:100 } } as T;
      if (path.startsWith("/turns")) return { turns:[{ id:"new", state, safe_error_code:"provider_api_error" }] } as T;
      return { events:[{ id:100, turn_id:"new", type:"turn_failed" }] } as T;
    };
    try {
      await expect(waitBrowserTurn(api, "session", "old", dir)).rejects.toThrow(`${state}: provider_api_error`);
      const saved = JSON.parse(readFileSync(join(dir, "turn-new.json"), "utf8"));
      expect(saved.turn.state).toBe(state);
      expect(saved.turn.safe_error_code).toBe("provider_api_error");
      expect(saved.events.events[0].id).toBe(100);
      expect(paths).toContain("/events?cursor=70&limit=30");
      expect(paths.filter(path => path.startsWith("/session-view"))).toHaveLength(1);
    } finally { rmSync(dir, { recursive:true, force:true }); }
  });
}

test("browser turn ignores the previous terminal turn and waits through active states", async () => {
  const turns = [{ id:"old", state:"failed" }, { id:"new", state:"streaming" }, { id:"new", state:"delivered" }];
  const api = async <T>(): Promise<T> => ({ latest_turn:turns.shift() }) as T;
  expect(await waitBrowserTurn(api, "session", "old")).toEqual({ id:"new", state:"delivered" });
});
