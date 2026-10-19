import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Turn = { id: string; state: string; safe_error_code?: string | null };
type View = { latest_turn?: Turn; cursors?: { events?: number } };
type Api = <T>(path: string) => Promise<T>;
const failedStates = new Set(["cancelled", "failed", "runtime_fault"]);

/** Wait for a new delivered turn, preserving terminal diagnostics before throwing. */
export async function waitBrowserTurn(api: Api, session: string, priorId?: string,
  evidence = process.env.BUTLER_BROWSER_EVIDENCE) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const view = await api<View>(`/session-view?session_id=${encodeURIComponent(session)}`);
    const turn = view.latest_turn;
    if (turn && turn.id !== priorId) {
      if (turn.state === "delivered") return turn;
      if (failedStates.has(turn.state)) {
        const cursor = Math.max(0, (view.cursors?.events ?? 30) - 30);
        const [events, turns] = await Promise.all([
          api<{ events: unknown[] }>(`/events?cursor=${cursor}&limit=30`).catch(error => ({ error: String(error) })),
          api<{ turns: Turn[] }>(`/turns?chat_id=${encodeURIComponent(session)}`).catch(() => ({ turns: [] })),
        ]);
        const detail = turns.turns.find(item => item.id === turn.id) ?? turn;
        if (evidence) {
          mkdirSync(evidence, { recursive: true });
          writeFileSync(join(evidence, `turn-${encodeURIComponent(turn.id)}.json`), JSON.stringify({ turn: detail, view, events }, null, 2));
        }
        throw new Error(`Turn ${turn.id} ended ${turn.state}${detail.safe_error_code ? `: ${detail.safe_error_code}` : ""}`);
      }
    }
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error("Timed out: delivered browser turn");
}
