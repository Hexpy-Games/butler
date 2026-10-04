// Browser behavior smoke: deterministic stub streaming, real virtual list and observer.
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { checkCapturedActivity } from "./activity-capture-support";
import { smokeBrowserArgs } from "../support/smoke-browser";

const uiRoot = resolve("packages/butler-app/client/ui/dist");
const output = resolve(".tmp/activity-layout");
mkdirSync(output, { recursive: true });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const path = new URL(request.url).pathname;
  const file = Bun.file(join(uiRoot, path === "/" ? "index.html" : path));
  return new Response(await file.exists() ? file : Bun.file(join(uiRoot, "index.html")));
} });
const browser = await chromium.launch({ headless: true, args: smokeBrowserArgs() });
const measurements: Array<{ width: number; theme: string; distance: number }> = [];
try {
  const page = await browser.newPage({ viewport: { width: 375, height: 900 }, reducedMotion: "reduce" });
  for (const width of [375, 1280]) for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`http://127.0.0.1:${server.port}/?visual=components&surface=activity-layout&theme=${theme}`);
    const message = page.locator('[data-test-class="message assistant"]').last();
    const live = message.locator('[data-test-class~="turn-activity-panel"]');
    await live.waitFor();
    assert.equal(await message.locator('[data-test-class="assistant-footer"]').count(), 0, "streaming hides footer");
    assert.equal(await message.locator('[data-test-class="turn-current-phase-activity"]').count(), 1, "one live activity, no completed summary");
    assert(await message.evaluate((node) => {
      const body = node.querySelector('[data-test-class="message-body"]')!;
      const live = node.querySelector('[data-test-class~="turn-activity-panel"]')!;
      return Boolean(body.firstElementChild!.compareDocumentPosition(live) & Node.DOCUMENT_POSITION_FOLLOWING);
    }), "streaming body precedes attached activity");
    await page.waitForFunction(() => {
      const scroll = document.querySelector('[data-test-class~="conversation-scroll"]');
      return scroll && scroll.scrollHeight > scroll.clientHeight;
    });
    await page.locator('[data-stub-stream-complete="true"]').waitFor();
    await page.waitForTimeout(240);
    const distance = await page.locator('[data-test-class~="conversation-scroll"]').evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop);
    measurements.push({ width, theme, distance });
    const streamedText = await message.locator('[data-test-class="markdown-document"]').innerText();
    assert(distance <= 2, `streaming remains pinned: ${distance}px`);
    await page.screenshot({ path: join(output, `running-${width}-${theme}.png`) });
    await page.getByRole("button", { name: "완료", exact: true }).click();
    const summary = message.getByRole("button", { name: /활동 · 완료/ });
    await summary.waitFor();
    assert.equal(await message.locator('[data-test-class="markdown-document"]').innerText(), streamedText, "completion retains all streamed content");
    assert.equal(await live.count(), 0, "live panel removed on completion");
    assert.equal(await message.locator('[data-test-class="assistant-footer"]').count(), 1);
    assert.equal(await summary.getAttribute("aria-expanded"), "false");
    assert(await message.evaluate((node) => {
      const summary = node.querySelector('[data-test-class="turn-current-phase-activity"]')!;
      const answer = node.querySelector('[data-test-class="turn-result-section"]')!;
      const footer = node.querySelector('[data-test-class="assistant-footer"]')!;
      return Boolean(summary.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING) &&
        Boolean(answer.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING);
    }), "completed summary precedes answer and footer");
    await page.screenshot({ path: join(output, `completed-${width}-${theme}.png`) });
    await page.getByRole("button", { name: "작업 기록", exact: true }).click();
    const dialog = page.locator('[data-test-class="activity-layout-observer"]');
    const history = dialog.getByRole("button", { name: /활동 · 완료/ });
    await history.waitFor();
    await history.click();
    await dialog.getByText("활동 화면 확인", { exact: true }).last().waitFor();
    await dialog.locator('[data-test-class~="turn-work-collapsed"] [data-test-class="toggle-turn-activity-disclosure"]').click();
    await dialog.locator('[data-test-class~="turn-work-tool-group"] > button').click();
    const tools = dialog.locator('[data-test-class="turn-work-tool-detail-row"]');
    assert.equal(await tools.count(), 2, "observer keeps every tool row after completion");
    assert((await tools.allTextContents()).join(" ").includes("보고서.txt"));
    await tools.last().waitFor({ state: "visible" });
    await page.waitForFunction(() => document.getAnimations().every(animation =>
      animation.effect?.getTiming().iterations === Infinity || animation.playState !== "running"));
    assert.equal(await dialog.locator('[data-test-class~="current-turn-status"]').count(), 0);
    assert(!/Steward|스튜어드/i.test(await dialog.innerText()));
    await dialog.screenshot({ path: join(output, `work-completed-${width}-${theme}.png`) });
    await page.goto(`http://127.0.0.1:${server.port}/?visual=components&surface=activity-layout&theme=${theme}&state=completed&list=1`);
    await page.getByRole("button", { name: /활동 · 완료/ }).nth(3).waitFor();
    assert.equal(await page.locator('[data-test-class="assistant-footer"]').count(), 4);
    await page.setViewportSize({ width, height: 1200 });
    await page.screenshot({ path: join(output, `completed-list-${width}-${theme}.png`) });

    for (const state of ["running", "completed"]) {
      await page.goto(`http://127.0.0.1:${server.port}/?visual=components&surface=activity-layout&theme=${theme}&state=${state}&approval=1`);
      const approval = page.locator('[data-test-class="composer-authority-decision"]');
      await approval.waitFor();
      const text = await approval.innerText();
      assert(text.includes("읽기 전용") && text.includes("파일") && text.includes("C:\\Users\\test\\Downloads"), "approval shows tool, access and exact path");
      await approval.screenshot({ path: join(output, `approval-${state}-${width}-${theme}.png`) });
      await page.getByRole("button", { name: "작업 기록", exact: true }).click();
      const observer = page.locator('[data-test-class="activity-layout-observer"]');
      await observer.locator('[data-test-class~="turn-work-collapsed"] [data-test-class="toggle-turn-activity-disclosure"]').click();
      await observer.locator('[data-test-class~="turn-work-tool-group"] > button').click();
      assert.equal(await observer.locator('[data-test-class="turn-work-tool-detail-row"]').count(), 2, `${state} observer lists all tools`);
      await observer.locator('[data-test-class="turn-work-tool-detail-row"]').last().waitFor({ state: "visible" });
      await page.waitForFunction(() => document.getAnimations().every(animation =>
        animation.effect?.getTiming().iterations === Infinity || animation.playState !== "running"));
      await page.screenshot({ path: join(output, `observer-${state}-${width}-${theme}.png`) });
    }

  }
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`http://127.0.0.1:${server.port}/?visual=components&surface=activity-layout&theme=dark`);
  await page.locator('[data-stub-stream-complete="true"]').waitFor();
  await page.getByRole("button", { name: "완료", exact: true }).click();
  const normalTurn = page.locator('[data-test-class="message assistant"]').last();
  await normalTurn.getByRole("button", { name: /활동 · 완료/ }).waitFor();
  assert.equal(await normalTurn.locator('[data-test-class="assistant-footer"]').count(), 1);
  assert.equal(await normalTurn.locator('[data-test-class~="turn-activity-panel"]').count(), 0);
  await checkCapturedActivity(page, `http://127.0.0.1:${server.port}`, output);
  console.log(JSON.stringify({ ok: true, screenshots: 32, measurements, checks: ["stream-order", "single-footer", "completed-history", "observer-history", "autoscroll", "completed-list", "ko-light-dark-mobile-desktop", "normal-and-reduced-motion"] }));
} finally { await browser.close(); server.stop(true); }
