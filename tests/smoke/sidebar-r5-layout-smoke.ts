import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { createTestAppServer } from "../../packages/butler-agent/src/test-support/app-server.ts";
import { FIRST_RUN_STORAGE_KEY, firstRunCompleteState } from "../../packages/butler-app/client/ui/src/app/firstRunSetup.ts";
import { readFirstChatOnboardingState, writeFirstChatOnboardingState } from "../../packages/butler-agent/src/personalization/onboarding.ts";
import { checkStickyClipping } from "./sidebar-sticky-clipping.ts";

// Layout fixtures only: real HTTP/store/UI, no provider or production data writes.
const dir = mkdtempSync(join(tmpdir(), "butler-sidebar-r5-"));
writeFirstChatOnboardingState(dir, { ...readFirstChatOnboardingState(dir), status: "complete", completed_at: new Date().toISOString() });
const output = resolve(".tmp/sidebar-r5");
mkdirSync(output, { recursive: true });
let finishReply: (() => void) | undefined;
const replyGate = new Promise<void>(resolveReply => { finishReply = resolveReply; });
const server = createTestAppServer({ butlerData: dir, dbPath: join(dir, "app.sqlite"),
  uiRoot: resolve("packages/butler-app/client/ui/dist"), port: 0,
  responder: async () => { await replyGate; return { texts: ["사이드바 완료 상태 검증 응답"] }; } });
const store = server.store;
const mutate = (fields: Record<string, unknown>) => store.mutateSpace({
  ...fields, expectedRevision: store.listNavigation().space.revision,
} as Parameters<typeof store.mutateSpace>[0]);
const group = mutate({ action: "create", title: "제품", parentKey: null });
const nested = mutate({ action: "create", title: "디자인", parentKey: `g:${group.groupId}` });
for (let i = 0; i < 40; i++) {
  const session = store.createSession({ kind: "chat", title: `검증 대화 ${i + 1}` }).session;
  if (i < 8) mutate({ action: "move", sourceKey: `s:${session.id}`, targetKey: `g:${i < 4 ? nested.groupId : group.groupId}`, position: "inside" });
  if (i < 2) mutate({ action: "pin", nodeKey: `s:${session.id}`, pinned: true });
}
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1440, 800, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
      { key: FIRST_RUN_STORAGE_KEY, value: firstRunCompleteState("ko") });
    await page.goto(server.url);
    const chrome = page.locator('[data-test-class="chrome-floating-toggle-layer"]');
    const show = chrome.getByRole("button", { name: "Show sidebar", exact: true });
    if (await show.isVisible()) await show.click();
    const hide = chrome.getByRole("button", { name: "Hide sidebar", exact: true });
    await hide.waitFor();
    await page.getByRole("button", { name: "검증 대화 1", exact: true }).first().waitFor();
    await page.waitForTimeout(250); // CSS panel transition, not runtime polling.
    const metrics = await page.evaluate(() => {
      const sidebar = document.querySelector<HTMLElement>('[aria-label="스페이스 탐색"]')!;
      const heading = (text: string) => [...sidebar.querySelectorAll("span")].find(el => el.textContent === text)!;
      const favoriteHeading = heading("즐겨찾기").parentElement!;
      const spaceHeading = heading("스페이스").parentElement!;
      const firstFavorite = favoriteHeading.nextElementSibling!.firstElementChild!;
      const list = sidebar.querySelector('[aria-label="대화 목록"]')!;
      const firstTree = list.firstElementChild!;
      const root = document.querySelector<HTMLElement>("[data-panel-layout]")!;
      const toggle = document.querySelector<HTMLElement>('[data-test-class="chrome-floating-toggle-layer"] button')!;
      const brand = [...sidebar.querySelectorAll("span")].find(el => el.textContent === "Butler")!;
      const rowLabels = [...list.querySelectorAll('[data-test-class="tree-row"]')];
      const more = sidebar.querySelector('[data-test-class="sidebar-load-more"]')!;
      const textLeft = (el: Element) => {
        const range = document.createRange();
        range.selectNodeContents(el.querySelector('[data-slot="nav-row-label"]')!);
        return range.getBoundingClientRect().left;
      };
      const groupedSession = rowLabels.find(el => el.textContent?.includes("검증 대화") &&
        el.getAttribute("aria-label") && el.closest("[data-sticky-clip]") === more.closest("[data-sticky-clip]"))!;
      return {
        width: innerWidth, layout: root.dataset.panelLayout,
        sidebarWidth: sidebar.getBoundingClientRect().width,
        favoriteGap: firstFavorite.getBoundingClientRect().top - favoriteHeading.getBoundingClientRect().bottom,
        spaceGap: firstTree.getBoundingClientRect().top - spaceHeading.getBoundingClientRect().bottom,
        titleVisible: brand.getBoundingClientRect().height > 0,
        toggle: { x: toggle.getBoundingClientRect().x, y: toggle.getBoundingClientRect().y },
        moreIndent: textLeft(more) - textLeft(groupedSession),
        background: getComputedStyle(sidebar).backgroundColor,
        stickyBackground: getComputedStyle(sidebar.querySelector('[data-test-class="sidebar-sticky-header"]')!).backgroundColor,
      };
    });
    assert.equal(metrics.layout, width <= 1023 ? "drawer" : "docked");
    if (width <= 1023) assert.equal(metrics.sidebarWidth, width);
    assert.equal(metrics.favoriteGap, 8);
    assert.equal(metrics.spaceGap, 8);
    assert.equal(metrics.moreIndent, 0);
    assert(metrics.titleVisible);
    assert.equal(metrics.background, "rgba(0, 0, 0, 0)");
    assert.equal(metrics.stickyBackground, "rgba(0, 0, 0, 0)");
    await page.screenshot({ path: join(output, `browser-${width}.png`) });
    await checkStickyClipping(page, join(output, `clipped-${width}.png`));
    await hide.click();
    await show.waitFor();
    await page.waitForTimeout(250);
    const closed = await show.boundingBox();
    assert.equal(closed?.x, metrics.toggle.x);
    assert.equal(closed?.y, metrics.toggle.y);
    await show.click();
    await hide.waitFor();
    const generalRow = page.locator('[aria-label="스페이스 탐색"]').getByRole("button", { name: "일반", exact: true });
    await generalRow.click();
    if (width <= 1023) await show.waitFor();
    if (width === 1440) {
      const result = fetch(`${server.url}messages`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: "general", text: "완료 상태 검증", client_message_id: "r5-completion" }) })
        .then(async response => { assert(response.ok, await response.clone().text()); return response; });
      await generalRow.locator('[role="status"]').waitFor({ state: "attached" });
      finishReply!();
      assert((await result).ok);
      await page.getByText("사이드바 완료 상태 검증 응답", { exact: true }).waitFor();
      await generalRow.locator('[role="status"]').waitFor({ state: "detached" });
      console.log("PASS HTTP turn → live event → actual sidebar spinner removed, without reload");
    }
    console.log(JSON.stringify(metrics));
    await page.close();
  }
} finally {
  await browser.close();
  server.stop();
}
