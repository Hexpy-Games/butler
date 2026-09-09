import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { createTestAppServer } from "../../packages/butler-agent/src/test-support/app-server.ts";
import { FIRST_RUN_STORAGE_KEY, firstRunCompleteState } from "../../packages/butler-app/client/ui/src/app/firstRunSetup.ts";
import { readFirstChatOnboardingState, writeFirstChatOnboardingState } from "../../packages/butler-agent/src/personalization/onboarding.ts";

// Isolated HTTP navigation fixture; actual SpaceRow/NavRow and CSS, no live work mutations.
const dir = mkdtempSync(join(tmpdir(), "butler-sidebar-overflow-"));
writeFirstChatOnboardingState(dir, { ...readFirstChatOnboardingState(dir), status: "complete", completed_at: new Date().toISOString() });
const output = resolve(".tmp/sidebar-overflow");
mkdirSync(output, { recursive: true });
const server = createTestAppServer({ butlerData: dir, dbPath: join(dir, "app.sqlite"),
  uiRoot: resolve("packages/butler-app/client/ui/dist"), port: 0 });
server.store.updateSettings({ language: "ko" });
const session = server.store.createSession({ kind: "chat", title: "긴 진행 상태와 소속 경로의 말줄임 표시 검증 대화" }).session;
const mutate = (fields: Record<string, unknown>) => server.store.mutateSpace({
  ...fields, expectedRevision: server.store.listNavigation().space.revision,
} as Parameters<typeof server.store.mutateSpace>[0]);
const group = mutate({ action: "create", title: "매우 긴 소속 프로젝트와 연구 자료를 정리하는 그룹", parentKey: null });
mutate({ action: "move", sourceKey: `s:${session.id}`, targetKey: `g:${group.groupId}`, position: "inside" });
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1440, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: "dark" });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
      { key: FIRST_RUN_STORAGE_KEY, value: firstRunCompleteState("ko") });
    let status = "Request received. Preparing the work.";
    await page.route("**/navigation", async route => {
      const response = await route.fetch();
      const body = await response.json();
      Object.assign(body.data.chats.find((chat: { id: string }) => chat.id === session.id), {
        active_turn_state: "thinking", safe_status_label: status,
        work_progress: { completed: 0, total: 1 },
      });
      await route.fulfill({ response, json: body });
    });
    for (const language of ["en", "ko"]) {
      status = language === "en" ? "Request received. Preparing the work." : "요청을 확인하고 필요한 자료와 실행 절차를 준비하고 있습니다.";
      await page.goto(server.url);
      await page.locator("[data-panel-layout]").waitFor();
      const show = page.getByRole("button", { name: "사이드바 보기", exact: true });
      if (await show.isVisible()) await show.click();
      const sidebar = page.locator('[aria-label="스페이스 탐색"]');
      await sidebar.getByRole("tab").nth(2).click();
      const row = sidebar.getByRole("button", { name: session.title, exact: true });
      await row.waitFor();
      const fullStatus = `${status} · 1/1`;
      const metrics = await row.evaluate((el, title) => {
        const meta = el.querySelector('[data-slot="nav-row-meta"]')!;
        const status = meta.querySelector(`[title="${title}"]`)!;
        const label = status.firstElementChild!;
        const count = status.lastElementChild!;
        const location = status.previousElementSibling!;
        return {
          rowRight: el.getBoundingClientRect().right, metaRight: meta.getBoundingClientRect().right,
          statusRight: status.getBoundingClientRect().right, countRight: count.getBoundingClientRect().right,
          countText: count.textContent, statusWidth: status.getBoundingClientRect().width,
          metaWidth: meta.getBoundingClientRect().width, locationWidth: location.getBoundingClientRect().width,
          labelOverflow: label.scrollWidth > label.clientWidth,
          ellipsis: getComputedStyle(label).textOverflow, whiteSpace: getComputedStyle(label).whiteSpace,
          locationEllipsis: getComputedStyle(location).textOverflow,
        };
      }, fullStatus);
      assert(metrics.statusRight <= metrics.metaRight + 1, JSON.stringify(metrics));
      assert(metrics.countRight <= metrics.rowRight - 7, JSON.stringify(metrics));
      assert(metrics.statusWidth <= metrics.metaWidth * 0.6 + 1, JSON.stringify(metrics));
      assert(metrics.locationWidth > 0 && metrics.labelOverflow, JSON.stringify(metrics));
      assert.equal(metrics.countText, " · 1/1");
      assert.equal(metrics.ellipsis, "ellipsis");
      assert.equal(metrics.whiteSpace, "nowrap");
      assert.equal(metrics.locationEllipsis, "ellipsis");
      await row.screenshot({ path: join(output, `status-${width}-${language}.png`) });
      await sidebar.getByRole("tab").nth(1).click();
      const recent = sidebar.getByRole("button", { name: session.title, exact: true });
      assert(await recent.locator("time").count());
      const timeRight = await recent.locator("time").evaluate(el => el.getBoundingClientRect().right);
      const rowRight = await recent.evaluate(el => el.getBoundingClientRect().right);
      assert(Math.abs(rowRight - timeRight - 8) < 1);
      console.log(`PASS ${width}/${language}: bounded ellipsis, full title, visible progress/location, recent time alignment`);
    }
    await page.unrouteAll({ behavior: "wait" });
    await page.close();
  }
} finally {
  await browser.close();
  server.stop();
}
