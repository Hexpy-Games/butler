// Replayed public event transport for native-App browser smokes.
import type { Page } from "playwright";

export async function installWorkReplay(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("butler:app-ui-state:v1", JSON.stringify({ schema: "butler.app-ui-state.v1",
      cached_at: new Date().toISOString(), active_session_id: "general", left_open: true, right_open: false }));
    // Stub only the transport. The App's real subscription, routing, queries and store run.
    class ReplayEventSource {
      onmessage?: (event: { data: string }) => void;
      onopen?: () => void;
      onerror?: () => void;
      constructor() {
        Object.assign(window, { __emitWorkEvent: (event: unknown) => this.onmessage?.({ data: JSON.stringify(event) }) });
        queueMicrotask(() => this.onopen?.());
      }
      addEventListener() {}
      close() {}
    }
    Object.assign(window, { EventSource: ReplayEventSource });
  });
}

export async function emitWorkChange(page: Page, childId: string): Promise<void> {
  await page.evaluate(childId => (window as unknown as { __emitWorkEvent: (event: unknown) => void }).__emitWorkEvent({
    id: 100, type: "subsession.changed", created_at: new Date().toISOString(),
    payload: { session_id: "general", child_session_id: childId },
  }), childId);
}
