// Isolated dashboard fixture at DASHBOARD_URL; never sends a conversation or changes a real project.
import assert from "node:assert/strict";
import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, hasTouch: true,
  storageState: process.env.DASHBOARD_TEST_STATE ?? ".tmp/project-dashboard-164/fixture-browser-state.json" });
const page = await context.newPage();
const failures: string[] = [];
page.on("pageerror", (error) => failures.push(error.message));
const base = process.env.DASHBOARD_URL ?? "http://127.0.0.1:18785";
assert(new URL(base).hostname === "127.0.0.1", "Use a local isolated fixture");
try {
  await page.goto(base);
  await page.getByRole("button", { name: "사이드바 보기", exact: true }).click();
  await page.getByRole("button", { name: "대시보드 검증 프로젝트 프로젝트 대시보드", exact: true }).click();
  await page.getByRole("tab", { name: "통계", exact: true }).click();
  const root = page.locator('[data-test-class="project-statistics"]');
  await root.getByText("모델 사용량", { exact: true }).waitFor();
  assert(!await root.getByText("사용자 메시지", { exact: true }).count());
  await root.getByRole("tab", { name: "Task", exact: true }).click();
  assert(await root.getByText("Task 완료 시각은 기존 원장 이력에 별도로 남지 않아 완료 추이를 집계할 수 없습니다. 등록 추이와 현재 단계만 표시합니다.", { exact: true }).count());
  await root.getByRole("tab", { name: "Work", exact: true }).click();
  await root.getByRole("button", { name: "예정 1", exact: true }).click();
  await root.getByRole("button", { name: "다음 조사 준비", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  assert((await page.getByRole("dialog").innerText()).includes("자료는 수집했지만"));
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  for (const width of [1280, 960, 430, 390, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await root.getByRole("tab", { name: "최근 7일", exact: true }).click();
    await root.getByText("모델 사용량", { exact: true }).waitFor();
    await root.getByRole("tab", { name: "최근 30일", exact: true }).click();
    await root.getByText("모델 사용량", { exact: true }).waitFor();
    for (const section of await root.locator("section").all()) {
      await section.scrollIntoViewIfNeeded();
      const box = await section.boundingBox();
      assert(box && box.x >= -1 && box.x + box.width <= width + 1, `${width}: section overflow`);
    }
    assert(!await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), `${width}: document overflow`);
    const chart = root.locator('.recharts-surface[role="application"]').first();
    await chart.scrollIntoViewIfNeeded();
    await chart.focus();
    await page.keyboard.press("ArrowRight");
    assert(await root.getByText(/기록 \d+개/).count());
    const days = root.getByRole("button", { name: / · 대화 \d+ · 작업 변경/ });
    await days.last().scrollIntoViewIfNeeded();
    await days.last().tap();
    assert.equal(await days.last().getAttribute("aria-pressed"), "true");
    await page.screenshot({ path: `/tmp/butler-statistics-${width}-calendar.png`, animations: "disabled" });
    await root.getByRole("heading", { name: "작업이 어떻게 달라졌나요", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/tmp/butler-statistics-${width}-flow.png`, animations: "disabled" });
  }
  const duration = root.locator("section").filter({ has: page.getByRole("heading", { name: "요청 처리에 걸린 시간", exact: true }) });
  await duration.scrollIntoViewIfNeeded();
  assert(await duration.locator(".recharts-bar").count() > 0, "Seed terminal-event fixture before running this smoke");
  await duration.getByRole("button", { name: "선택한 기록 +1", exact: true }).click();
  assert(await duration.getByText(/기록 \d+개/).count());
  await page.screenshot({ path: "/tmp/butler-statistics-320-duration.png", animations: "disabled" });
  const materials = root.locator("section").filter({ has: page.getByRole("heading", { name: "자료와 결과물의 변화", exact: true }) });
  await materials.getByRole("tab", { name: "변경별", exact: true }).click();
  assert(await materials.getByText("수정", { exact: true }).count());
  await materials.getByRole("tab", { name: "종류별", exact: true }).click();
  assert(await materials.getByText("명세", { exact: true }).count());
  await materials.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/butler-statistics-320-materials.png", animations: "disabled" });
  assert.deepEqual(failures, []);
  console.log(JSON.stringify({ passed: true, widths: [1280, 960, 430, 390, 375, 320], sourceDialog: true, touch: true, keyboard: true }));
} finally { await browser.close(); }
