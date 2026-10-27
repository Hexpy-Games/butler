// Settings containers -> isolated native gateway; browser data is an offline fixture.
import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Page } from "playwright";
import { createNativeAppServer } from "../support/native-app-server";
import { launchSmokeBrowser } from "../support/smoke-browser";
import { getAppCopy } from "../../packages/butler-i18n/src";

const before = process.env.BUTLER_SETTINGS_BEFORE_UI;
const stage = before ? "before" : "after";
const output = process.env.BUTLER_SETTINGS_BROWSER_EVIDENCE;
assert.ok(output, "explicit evidence directory required");
mkdirSync(join(output, stage), { recursive: true });
const report: Record<string, unknown>[] = [];
const section = (page: Page, id: string) => page.locator(`[data-settings-section-id="${id}"]`);
const browser = await launchSmokeBrowser();
const server = await createNativeAppServer({ uiRoot: resolve(before ?? "packages/butler-app/client/ui/dist") });
const admin = JSON.parse(readFileSync(join(server.butlerData, "app/runtime/auth/local-admin.json"), "utf8")).secret as string;
const defaultBrowsingAgent = (await server.api<{ browser: { browsing_agent: string } }>("/settings")).browser.browsing_agent;
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });

async function capture(name: string) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), name);
  await page.screenshot({ path: join(output!, stage, `${name}.png`) });
}

async function open(id: string, title: string) {
  await page.goto(`${server.url}?settings=${encodeURIComponent(id)}`);
  await page.locator('[data-test-class~="settings-detail-title"]').getByText(title, { exact: true }).waitFor();
}

async function matrix(locale: "ko" | "en", theme: "light" | "dark") {
  const copy = getAppCopy(locale === "ko" ? "ko-KR" : "en-US");
  const key = `${locale}-${theme}-1440`;
  await server.api("/settings", { method: "PATCH", body: JSON.stringify({ language: locale, appearance_theme: theme,
    wallpaper: { source: { kind: "none" }, motion: "paused", pauseOnBattery: false } }) });
  await open("security", copy.settings.sections.security);
  await section(page, "security-advanced").waitFor();
  assert.equal(await section(page, "sign-ins").count(), 0);
  assert.equal(await section(page, "browser-import").count(), 0);
  assert.equal(await section(page, "headless-browser").count(), 0);
  for (const id of ["grants", "saved-keys"]) await section(page, id).waitFor();
  await capture(`security-${key}`);
  {
    await open("browser", copy.settings.sections.browser);
    await section(page, "sign-ins").locator('[data-test-class="sign-in-row"]').waitFor();
    if (before) await section(page, "browser-import").getByText(copy.settings.browserImport.passwords, { exact: true }).waitFor();
    else await section(page, "browser-import").getByRole("button", { name: copy.settings.browserImport.open, exact: true }).waitFor();
    assert.deepEqual(await page.locator("[data-settings-section-id]").evaluateAll(nodes => nodes.map(n => n.getAttribute("data-settings-section-id"))), [...(!before ? ["browsing-agent"] : []), "browser-history", "browser-site-data", "sign-ins", "payment-methods", "profiles", "purchase-sites", "browser-import"]);
    if (!before) {
      const settings = await server.api<{ browser: { auto: { model: string; available: boolean } } }>("/settings");
      const catalog = await server.api<{ models: { model_ref: string; display_name: string }[]; registered_models: { model_ref: string; display_name: string }[] }>("/model-catalog");
      const resolvedName = [...catalog.registered_models, ...catalog.models].find(model => model.model_ref === settings.browser.auto.model)?.display_name;
      const autoLabel = copy.settings.browsingAgent.auto(settings.browser.auto.available && resolvedName ? resolvedName : copy.settings.browsingAgent.conversationModel);
      const field = section(page, "browsing-agent");
      const select = field.getByRole("combobox", { name: copy.settings.browsingAgent.label });
      const defaultLabel = defaultBrowsingAgent === "auto" ? autoLabel : copy.settings.browsingAgent.off;
      await select.getByText(defaultLabel, { exact: true }).waitFor();
      await capture(`browser-default-${key}`);
      await select.click();
      await page.getByRole("option", { name: copy.settings.browsingAgent.off, exact: true }).click();
      await select.getByText(copy.settings.browsingAgent.off, { exact: true }).waitFor();
      assert.equal((await server.api<{ browser: { browsing_agent: string } }>("/settings")).browser.browsing_agent, "off");
      await select.click();
      await page.getByRole("option", { name: autoLabel, exact: true }).click();
      await select.getByText(autoLabel, { exact: true }).waitFor();
      await select.click();
      await page.getByRole("option", { name: defaultLabel, exact: true }).click();
      await select.getByText(defaultLabel, { exact: true }).waitFor();
    }
    await capture(`browser-${key}`);
    const group = page.getByText(copy.settings.groups.appAndSystem, { exact: true }).locator("..");
    assert(await group.count(), "app and system group remains visible");
    for (const link of ["signin", "security/sign-ins", "browser-import", "로그인 저장"]) {
      await open(link, copy.settings.sections.browser);
      await section(page, "browser-import").waitFor();
    }
    const search = page.locator('[data-test-class="settings-navigation-search"]');
    await search.fill(locale === "ko" ? "로그인" : "sign-ins");
    assert.equal(await page.getByRole("button", { name: copy.settings.sections.browser, exact: true }).count(), 1);
    assert.equal(await page.getByRole("button", { name: copy.settings.sections.security, exact: true }).count(), 0);
    await search.fill("");
    await page.getByRole("button", { name: copy.settings.back, exact: true }).first().click();
    await page.keyboard.press("Meta+k");
    const palette = page.getByRole("dialog");
    await palette.getByRole("combobox").fill(locale === "ko" ? "로그인" : "sign-ins");
    await palette.getByRole("option").filter({ has: page.getByText(copy.settings.sections.browser, { exact: true }) }).click();
    await section(page, "sign-ins").waitFor();
  }
  await open("general", copy.settings.sections.general);
  await section(page, "search-behavior").scrollIntoViewIfNeeded();
  const searchText = await section(page, "search-provider").innerText() + "\n" + await section(page, "search-behavior").innerText();
  report.push({ key, searchText });
  await capture(`general-search-${key}`);
}

try {
  await server.signIn(page);
  await page.route(`${server.url}security**`, async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/security/signins") {
      await route.fulfill({ json: { data: { available: true, sites: [{ site: "example.test", entry: {
        id: "12345678-1234-1234-1234-123456789012", username: "reader@example.test", policy: "ask", last_used_at: null,
      }, conversations: 0, all_conversations: false, uses: [] }] } } });
    } else if (path === "/security/browser-import/sources") {
      await route.fulfill({ json: { data: { sources: [{ key: "fixture", browser: "chromium", name: "Default" }] } } });
    } else {
      const response = await route.fetch({ headers: { ...route.request().headers(), ...server.authHeaders, "x-butler-admin": admin } });
      const body = await response.json();
      if (before && path === "/security") Object.assign(body.data, { headless_browser: true, headless_browser_app: true });
      await route.fulfill({ response, json: body });
    }
  });
  for (const locale of ["ko", "en"] as const) for (const theme of ["light", "dark"] as const) await matrix(locale, theme);
  assert.equal(server.stubModelCalls.length, 0);
  if (!before) {
    const baseline = JSON.parse(readFileSync(join(output, "before", "report.json"), "utf8"));
    assert.deepEqual(report, baseline.report, "General search sections retain all copy, controls and order");
  }
  writeFileSync(join(output, stage, "report.json"), JSON.stringify({ stage, report, modelCalls: 0 }, null, 2));
  console.log(JSON.stringify({ ok: true, stage, cells: report.length, screenshots: report.length * (before ? 3 : 4), modelCalls: 0 }));
} finally { await browser.close(); await server.stop(); }
