// Canon conversations use the normal session sources in flat sidebar views.
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";
import type { NavigationView } from "../../packages/butler-app/client/ui/src/app/types.ts";

const output = process.env.BUTLER_SMOKE_SCREENSHOTS;
assert(output, "Set BUTLER_SMOKE_SCREENSHOTS to a temporary directory");
mkdirSync(output, { recursive: true });
let release: (() => void) | undefined;
const server = await createNativeAppServer({
  config: { user: { name: "Smoke", language: "ko" } },
  stubReply: async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    return "Finished.";
  },
});
const browser = await launchSmokeBrowser();
const post = <T>(path: string, body: unknown) => server.api<T>(path, { method: "POST", body: JSON.stringify(body) });
try {
  const { project } = await post<{ project: { id: string } }>("/projects", { source: "scratch", display_name: "Canon smoke" });
  const work = await post<{ id: string }>(`/projects/${project.id}/canon/epics`, { title: "Canon conversation" });
  const { session_id: chat } = await post<{ session_id: string }>(`/canon/epics/${work.id}/conversation`, {});
  await post("/messages", { chat_id: chat, text: "Stay active", client_message_id: crypto.randomUUID() });
  for (const theme of ["light", "dark"]) {
    await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: theme }) });
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 820 } });
      await server.signIn(page);
      await page.goto(server.url);
      const sidebar = page.locator('[data-test-class="app-sidebar"]');
      const toggle = page.getByRole("button", { name: /^(사이드바 보기|Show sidebar)$/u }).first();
      await sidebar.waitFor({ state: "attached" });
      if (await sidebar.getAttribute("data-collapsed") === "true") {
        await toggle.waitFor();
        await toggle.click();
      }
      const row = sidebar.locator('[data-test-class="tree-row"][aria-label="Canon conversation"]');
      await sidebar.getByRole("tab").nth(0).click();
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await row.count(), 0, "project tree excludes the conversation");
      await page.screenshot({ path: join(output, `${theme}-${width}-tree.png`) });
      await sidebar.getByRole("tab").nth(1).click();
      await row.first().waitFor();
      await page.screenshot({ path: join(output, `${theme}-${width}-recent.png`) });
      await sidebar.getByRole("tab").nth(2).click();
      await row.first().waitFor();
      await page.screenshot({ path: join(output, `${theme}-${width}-running.png`) });
      await page.close();
    }
  }
  const { space } = await server.api<NavigationView>("/navigation");
  await post("/space/pins", { nodeKey: `s:${chat}`, pinned: true, expectedRevision: space.revision });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await server.signIn(page);
  await page.goto(server.url);
  await page.locator('[data-test-class="app-sidebar"] [data-test-class="tree-row"][aria-label="Canon conversation"]').first().waitFor();
  await page.screenshot({ path: join(output, "favorite.png") });
  await page.close();
  console.log("Canon sidebar: tree exclusion, recent, running, favorites; 13 captures");
} finally {
  release?.();
  await browser.close();
  await server.stop();
}
