import type { Page, Request } from "playwright";

const QUIET_MS = 500;

/**
 * `page.goto`, resolved once no request has been in flight for 500 ms (the
 * documented meaning of Playwright's "networkidle"), counted from the page's
 * own request events. Playwright's "networkidle" can be lost for good: when a
 * request starts and ends in an iframe after that frame went idle, the frame
 * never restarts its idle timer, and the next recalculation drops its idle
 * state, so the page never becomes idle again (#860). The DS viewer's device
 * frames copy the page's late style sheets in, which hits this.
 */
export async function gotoNetworkQuiet(page: Page, url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const inflight = new Set<Request>();
  let changed = Date.now();
  const started = (request: Request) => { inflight.add(request); changed = Date.now(); };
  const ended = (request: Request) => { inflight.delete(request); changed = Date.now(); };
  page.on("request", started);
  page.on("requestfinished", ended);
  page.on("requestfailed", ended);
  try {
    await page.goto(url, { waitUntil: "load", timeout: timeoutMs });
    while (inflight.size > 0 || Date.now() - changed < QUIET_MS) {
      if (Date.now() >= deadline) {
        const pending = [...inflight].map((request) => request.url()).slice(0, 5).join(", ");
        throw new Error(`goto ${url}: network not quiet within ${timeoutMs} ms (${inflight.size} in flight: ${pending})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    page.off("request", started);
    page.off("requestfinished", ended);
    page.off("requestfailed", ended);
  }
}
