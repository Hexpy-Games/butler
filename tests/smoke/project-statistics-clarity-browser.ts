// Isolated browser and read-only production data. Never migrates DB or invokes a model.
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { AppProjectDashboardStore } from "../../packages/butler-agent/src/gateways/app/domain/projects/project-dashboard-store.ts";
import type { ProjectRow } from "../../packages/butler-agent/src/gateways/app/infrastructure/core/records.ts";
import { handleProjectSessionRoutes } from "../../packages/butler-agent/src/gateways/app/interface/server/routes/project-session-routes.ts";
import type { AppRouteContext } from "../../packages/butler-agent/src/gateways/app/interface/server/server-types.ts";

const butlerData = process.env.BUTLER_DATA ?? `${process.env.HOME}/.butler`;
const projectId = process.env.DASHBOARD_PROJECT ?? "project-sandy-bot-35a0e102";
const output = "/tmp/statistics-clarity";
const db = new Database(`${butlerData}/app-server/butler-client.sqlite`, { readonly: true });
const store = new AppProjectDashboardStore(db, butlerData,
  (id) => db.query<ProjectRow, [string]>("SELECT * FROM projects WHERE id=?").get(id), () => [],
  () => { throw new Error("No briefing/model access in statistics inspection"); }, () => { throw new Error("No writes"); });
const durations: Array<{ days: number; ms: number }> = [];
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (request.method !== "GET" || !url.pathname.endsWith("/dashboard/statistics")) return new Response(null, { status: 403 });
  const started = performance.now();
  const response = await handleProjectSessionRoutes({ request, url, store: {
    getProjectDashboardStatistics: store.getStatistics.bind(store),
  } } as unknown as AppRouteContext);
  durations.push({ days: Number(url.searchParams.get("days")), ms: Math.round(performance.now() - started) });
  console.log(JSON.stringify(durations.at(-1)));
  return response ?? new Response(null, { status: 404 });
} });
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors: string[] = [];
page.on("pageerror", error => errors.push(error.message));
try {
  await page.route("**/projects/**/dashboard/statistics?**", async route => {
    const url = new URL(route.request().url());
    const response = await page.request.get(`http://127.0.0.1:${server.port}${url.pathname}${url.search}`, { timeout: 60000 });
    await route.fulfill({ response });
  });
  await page.goto("http://127.0.0.1:5173/?visual=design-system");
  await page.getByRole("tab", { name: "Blocks", exact: true }).waitFor();
  await page.evaluate(async ({ projectId }) => {
    const path = "/src/components/management/ProjectStatisticsPanel.tsx";
    const source = await (await fetch(path)).text();
    const urls = [...source.matchAll(/from "([^"]+)"/g)].map(match => match[1]!);
    const reactUrl = urls.find(url => /\/react.js\?/.test(url))!;
    const React = (await import(reactUrl)).default;
    const { createRoot } = (await import(reactUrl.replace("/react.js?", "/react-dom_client.js?"))).default;
    const load = (url: string) => import(url);
    (await load(urls.find(url => url.includes("/app/copy.ts"))!)).setAppCopyLanguage("ko");
    const { ProjectStatisticsPanel } = await load(path);
    for (const child of document.body.children) (child as HTMLElement).style.display = "none";
    const host = document.createElement("main");
    host.style.cssText = "position:absolute;inset:0;padding:16px;container:project-dashboard / inline-size;background:var(--surface-raised);overflow:auto";
    document.body.append(host);
    createRoot(host).render(React.createElement(ProjectStatisticsPanel, { projectId, onSelect() {} }));
  }, { projectId });
  const panel = page.locator('[data-test-class="project-statistics"]');
  await panel.getByRole("heading", { name: "작업 현황", exact: true }).waitFor({ timeout: 60000 });
  for (const days of [7, 90, 30]) {
    await panel.getByRole("tab", { name: `최근 ${days}일`, exact: true }).click();
    await page.waitForFunction(count => document.querySelectorAll("button[data-level]").length === count, days, { timeout: 25000 });
    assert.equal(await panel.getByRole("status").count(), 0);
    await panel.locator('[aria-label="프로젝트 활동"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${output}/${days}-day-calendar.png`, animations: "disabled" });
  }
  for (const width of [1440, 430, 390, 375, 320]) {
    await page.setViewportSize({ width, height: 1100 });
    const group = panel.locator('[data-test-class="work-statistics-group"]');
    const title = group.getByRole("heading", { name: "작업 현황", exact: true });
    const tabs = group.getByRole("tablist");
    const [heading, controls] = await Promise.all([title.boundingBox(), tabs.boundingBox()]);
    assert(heading && controls && Math.abs((heading.y + heading.height / 2) - (controls.y + controls.height / 2)) < 3);
    assert.equal(await group.locator("section").filter({ has: page.getByRole("tablist") }).count(), 0, "Child charts must not own scope controls");
    await group.getByRole("tab", { name: "Task", exact: true }).click();
    await group.getByRole("tab", { name: "Work", exact: true }).click();
    await group.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${output}/${width}-work.png`, animations: "disabled" });
    const calendar = panel.locator('[aria-label="프로젝트 활동"]');
    await calendar.scrollIntoViewIfNeeded();
    await calendar.locator("button[data-level]").last().click();
    assert.equal(await calendar.locator('button[aria-pressed="true"]').count(), 1);
    assert.equal(await calendar.getByText("색상별 하루 활동 항목 수", { exact: true }).count(), 0);
    assert.equal(await panel.getByText(/^예: 대화/).count(), 0);
    assert.equal(await panel.getByText(/개별 도구 호출은/).count(), 0);
    assert.equal(await calendar.locator('[class*="legendItem"]').count(), 7); // wrapper plus six items
    assert(!await page.evaluate(() => document.documentElement.scrollWidth > innerWidth));
    await page.screenshot({ path: `${output}/${width}-activity.png`, animations: "disabled" });
  }
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.emulateMedia({ colorScheme: "dark" });
  await panel.locator('[aria-label="프로젝트 활동"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${output}/dark-activity.png`, animations: "disabled" });
  assert.deepEqual(errors, []);
  await writeFile(`${output}/timings.json`, JSON.stringify(durations, null, 2));
  console.log(JSON.stringify({ pass: true, durations, output }));
} catch (error) {
  console.log(JSON.stringify({ errors, durations, text: (await page.locator("main").last().innerText()).slice(0, 500) }));
  await page.screenshot({ path: `${output}/failure.png` });
  throw error;
} finally { await browser.close(); server.stop(true); db.close(); }
