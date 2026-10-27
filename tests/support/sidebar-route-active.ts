import { strict as assert } from "node:assert";
import { type browserAgentApp, waitBrowser } from "./browser-agent-app";

type App = Awaited<ReturnType<typeof browserAgentApp>>;

export async function sidebarRouteActive(app: App) {
  return app.page.expression<{ rows: string[]; sessions: string[]; browser: boolean; library: boolean }>(`(() => {
    const sidebar = document.querySelector('[data-slot=adaptive-shell-sidebar]');
    const active = '[aria-current="page"]';
    const label = node => (node.getAttribute('aria-label') || node.textContent || '').trim();
    const entry = name => Boolean(sidebar?.querySelector('[data-test-class="' + name + '"]' + active + ', [data-test-class="' + name + '"] ' + active));
    return {
      rows: [...(sidebar?.querySelectorAll(active) || [])].map(label),
      sessions: [...(sidebar?.querySelectorAll('[data-test-class=tree-row]' + active) || [])].map(label),
      browser: entry('browser-entry'), library: entry('library-entry'),
    };
  })()`);
}

export async function assertSidebarRouteActive(app: App, destination: "session" | "browser" | "library", label: string) {
  let actual = await sidebarRouteActive(app);
  const matches = () => actual.rows.length === 1 && actual.rows[0] === label
    && actual.sessions.length === (destination === "session" ? 1 : 0)
    && actual.browser === (destination === "browser") && actual.library === (destination === "library");
  await waitBrowser(async () => { actual = await sidebarRouteActive(app); return matches(); },
    `sidebar route ${destination}: expected only ${JSON.stringify(label)} active; no stale session highlight`)
    .catch(() => assert.fail(`Sidebar route ${destination}: expected only ${JSON.stringify(label)} active; actual ${JSON.stringify(actual)}`));
  assert.ok(matches(), `Sidebar follows ${destination} route`);
}
