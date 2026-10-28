// test-category: race
import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import type { Browser, Locator } from "playwright";
import { probeFocusRing, probeFocusRingFrames } from "./focus-ring-clipping.ts";
import { createNativeAppServer } from "./native-app-server.ts";

export async function verifyInlineTriggerRings(scope: Locator) {
  const page = scope.page();
  await page.keyboard.press("Tab");
  for (const name of ["제목 수정", "설명 편집"]) {
    const trigger = scope.getByRole("button", { name, exact: true });
    await trigger.waitFor();
    const clips = await probeFocusRingFrames(page, () => trigger.focus());
    const probe = await probeFocusRing(page);
    assert(probe && !probe.noIndicator, `${name} has a visible focus ring`);
    assert.deepEqual([...clips, ...probe.clips], [], `${name} fits its pane`);
  }
  const heading = scope.getByRole("heading").first();
  const description = scope.getByRole("group", { name: "설명 편집", exact: true }).locator('[data-test-class="canon-markdown"]');
  const titleBox = await heading.boundingBox(), descriptionBox = await description.boundingBox();
  assert(titleBox && descriptionBox && Math.abs(titleBox.x - descriptionBox.x) < 1, "Title and description text stay aligned");
}

/** Real product panes, with isolated native data and no provider calls. */
export async function auditInlinePanes(browser: Browser) {
  const server = await createNativeAppServer({ uiRoot: resolve(process.env.BUTLER_SMOKE_UI_ROOT ?? "packages/butler-app/client/ui/dist") });
  let stops = 0;
  try {
    const { project } = await server.api<{ project: { id: string } }>("/projects", { method: "POST", body: JSON.stringify({ source: "scratch", display_name: "포커스 확인" }) });
    const epic = await server.api<{ id: string }>(`/projects/${project.id}/canon/epics`, { method: "POST", body: JSON.stringify({ title: "화면 확인", description: "제목과 설명을 확인합니다." }) });
    const linked = await server.api<{ session_id: string }>(`/canon/epics/${epic.id}/conversation`, { method: "POST", body: "{}" });
    for (const theme of ["dark", "light"]) {
      await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "ko", appearance_theme: theme, text_size: process.env.BUTLER_SMOKE_TEXT_SIZE ?? "default", reduce_motion: true }) });
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
      try {
        await server.signIn(page.context());
        await page.addInitScript(id => localStorage.setItem("butler:app-ui-state:v1", JSON.stringify({
          schema: "butler.app-ui-state.v1", cached_at: new Date().toISOString(), active_session_id: id,
          left_open: true, right_open: false, session_info_open: true,
        })), linked.session_id);
        await page.goto(server.url);
        for (const width of [1440, 1024]) {
          await page.setViewportSize({ width, height: 900 });
          const layout = width === 1440 ? "docked" : "floating";
          const aside = page.locator(`[data-slot="conversation-aside"][data-layout="${layout}"]`);
          await aside.waitFor();
          await page.locator(`[data-slot="conversation-aside"]:not([data-layout="${layout}"])`).waitFor({ state: "detached" });
          await verifyInlineTriggerRings(aside); stops += 2;
        }
        await page.getByRole("button", { name: "포커스 확인 프로젝트 대시보드", exact: true }).click();
        await page.getByRole("tab", { name: "보드", exact: true }).click();
        await page.locator(`[data-kanban-item="${epic.id}"]`).getByRole("button").first().click();
        for (const width of [1440, 1024]) {
          await page.setViewportSize({ width, height: 900 });
          const layout = width === 1440 ? "docked" : "floating";
          const aside = page.locator(`[data-slot="management-page-aside"][data-layout="${layout}"]`);
          await aside.waitFor();
          await page.locator(`[data-slot="management-page-aside"]:not([data-layout="${layout}"])`).waitFor({ state: "detached" });
          await verifyInlineTriggerRings(aside); stops += 2;
        }
      } finally { await page.close(); }
    }
    assert.equal(server.stubModelCalls.length, 0);
    return { stops, clipped: 0 };
  } finally { await server.stop(); }
}
