// Real components + read-only local API. Isolated browser; no project mutations or messages.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const base = process.env.DASHBOARD_VITE ?? "http://127.0.0.1:5173";
const apiBase = process.env.DASHBOARD_API ?? "http://127.0.0.1:18765";
const projectId = process.env.DASHBOARD_PROJECT ?? "project-sandy-bot-35a0e102";
assert([base, apiBase].every(url => new URL(url).hostname === "127.0.0.1"));
const output = process.env.DASHBOARD_EVIDENCE ?? "/tmp/dashboard-density";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors: string[] = [];
page.on("pageerror", error => errors.push(error.message));
try {
  await page.route("**/projects/**", async route => {
    assert.equal(route.request().method(), "GET", "Preview must not mutate project state");
    const url = new URL(route.request().url());
    const response = await page.request.get(`${apiBase}${url.pathname}${url.search}`, { timeout: 120000 });
    await route.fulfill({ response });
  });
  const response = await page.request.get(`${apiBase}/projects/${projectId}/dashboard`);
  const { data } = await response.json();
  assert(data?.overview, "Real dashboard response required");
  // Needed briefings are not generated for a layout inspection.
  if (data.briefing?.status === "needed") data.briefing.status = "unavailable";
  await page.goto(`${base}/?visual=design-system`);
  await page.getByRole("tab", { name: "Blocks", exact: true }).waitFor();
  await page.evaluate(async ({ data, projectId }) => {
    const path = "/src/components/management/ProjectDashboardView.tsx";
    const source = await (await fetch(path)).text();
    const urls = [...source.matchAll(/from "([^"]+)"/g)].map(match => match[1]!);
    const reactUrl = urls.find(url => /\/react.js\?/.test(url))!;
    const React = (await import(reactUrl)).default;
    const { createRoot } = (await import(reactUrl.replace("/react.js?", "/react-dom_client.js?"))).default;
    const copy = await import(urls.find(url => url.includes("/app/copy.ts"))!);
    copy.setAppCopyLanguage("ko");
    const { ProjectDashboardView } = await import(path);
    for (const child of document.body.children) (child as HTMLElement).style.display = "none";
    const host = document.createElement("div");
    host.id = "density-preview";
    host.style.cssText = "position:fixed;inset:0;width:100%;height:100%;background:var(--surface-raised)";
    document.body.append(host);
    createRoot(host).render(React.createElement(ProjectDashboardView, {
      project: { ...data.project, id: projectId }, initialDashboard: data,
    }));
  }, { data, projectId });
  const dashboard = page.locator('[data-test-class="project-dashboard-view"]');
  await dashboard.waitFor();
  const tabs = dashboard.locator("main").getByRole("tablist").first();
  const checks: unknown[] = [];
  for (const [width, hostWidth] of [[1440, 1440], [1440, 700], [430, 430], [390, 390], [375, 375], [320, 320]]) {
    await page.setViewportSize({ width: width!, height: 1100 });
    await page.locator("#density-preview").evaluate((host, size) => { (host as HTMLElement).style.width = `${size}px`; }, hostWidth);
    for (const tab of ["개요", "통계"]) {
      await tabs.getByRole("tab", { name: tab, exact: true }).click();
      if (tab === "통계") await dashboard.getByRole("heading", { name: "프로젝트 활동", exact: true }).waitFor();
      await page.waitForTimeout(250); // Existing tab and chart enter transitions.
      const grids = await dashboard.locator('[class*="overviewPair"], [class*="weightedPair"], [class*="_pair_"]').evaluateAll(elements =>
        elements.map(el => ({ columns: getComputedStyle(el).gridTemplateColumns.split(" ").length,
          width: el.getBoundingClientRect().width })));
      assert(grids.length > 0);
      for (const grid of grids) assert.equal(grid.columns, hostWidth! >= 1000 ? 2 : 1, `${width}/${hostWidth}/${tab}: container layout`);
      assert(!await page.evaluate(() => document.documentElement.scrollWidth > innerWidth));
      const main = dashboard.locator("main");
      await main.evaluate(el => { el.parentElement!.parentElement!.scrollTop = 0; });
      await page.screenshot({ path: `${output}/${width}-${hostWidth}-${tab === "개요" ? "overview" : "statistics"}.png`, animations: "disabled" });
      if (tab === "통계") {
        const heatmap = dashboard.locator('[aria-label="프로젝트 활동"]').filter({ has: page.locator("button[data-level]") });
        await heatmap.scrollIntoViewIfNeeded();
        assert.equal(await heatmap.locator("button[data-level]").count(), 30);
        await heatmap.locator("button[data-level]").last().click();
        assert.equal(await heatmap.locator('button[aria-pressed="true"]').count(), 1);
        await page.screenshot({ path: `${output}/${width}-${hostWidth}-activity.png`, animations: "disabled" });
      }
      checks.push({ width, hostWidth, tab, grids });
    }
  }
  // Long-range API latency is independent of the layout smoke.
  if (process.env.DASHBOARD_LONG_RANGE === "1") {
    await dashboard.getByRole("tab", { name: "최근 90일", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll("button[data-level]").length === 90, undefined, { timeout: 120000 });
  }
  const recordedDay = dashboard.locator('button[data-level="4"]').last();
  await recordedDay.focus();
  await page.keyboard.press("Enter");
  assert.equal(await recordedDay.getAttribute("aria-pressed"), "true");
  assert(!await page.evaluate(() => document.documentElement.scrollWidth > innerWidth));
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.locator("#density-preview").evaluate(host => { (host as HTMLElement).style.width = "100%"; });
  await page.emulateMedia({ colorScheme: "dark" });
  await recordedDay.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${output}/desktop-activity-dark.png`, animations: "disabled" });
  assert.deepEqual(errors, []);
  await writeFile(`${output}/checks.json`, JSON.stringify({ pass: true, checks }, null, 2));
  console.log(`PASS: ${checks.length} responsive real-data views; date selection; no page errors. ${output}`);
} finally { await browser.close(); }
