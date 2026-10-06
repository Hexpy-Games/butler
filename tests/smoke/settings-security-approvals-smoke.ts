// Public UI -> isolated Rust gateway, existing authority storage, stub models only.
import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Page, type Route } from "playwright";
import { launchSmokeBrowser } from "../support/smoke-browser.ts";
import { createNativeAppServer } from "../support/native-app-server.ts";
import { seedApprovalFixture } from "../support/authority-grant-fixture.ts";
import { appCopy, setAppCopyLanguage } from "../../packages/butler-app/client/ui/src/app/copy.ts";
import type { GrantRecord } from "../../packages/butler-app/client/ui/src/components/settings/grantRows.ts";

const before = process.env.BUTLER_APPROVALS_BEFORE === "1";
const output = resolve(`.tmp/security-approvals/${before ? "before" : "after"}`);
mkdirSync(output, { recursive: true });
const browser = await launchSmokeBrowser();
const section = (page: Page, id: string) => page.locator(`[data-settings-section-id="${id}"]`);
const rows = (page: Page) => section(page, "grants").locator('[data-test-class="grant-row"]');
const screenshots: string[] = [];

async function screenshot(page: Page, key: string, id: string) {
  console.log(`screenshot ${key} ${id} scroll`);
  const dialog = page.getByRole("alertdialog");
  await (await dialog.count() ? dialog : section(page, id)).scrollIntoViewIfNeeded({ timeout: 10_000 });
  console.log(`screenshot ${key} ${id} fonts`);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done())));
  });
  const path = join(output, `${key}-${id}.png`);
  console.log(`screenshot ${key} ${id} capture`);
  await page.screenshot({ path, animations: "allow", timeout: 10_000 }); screenshots.push(path);
}
async function sectionIds(page: Page) {
  return page.locator('[data-settings-section-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute("data-settings-section-id")));
}
async function open(page: Page, url: string, name: string, width: number) {
  await page.setViewportSize({ width: 1280, height: 900 });
  if (before) {
    if (!page.url().startsWith(url)) {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const settings = page.getByRole("button", { name: appCopy.sidebar.settings, exact: true });
    const showSidebar = page.getByRole("button", { name: appCopy.titlebar.showLeftPanel, exact: true });
    await settings.or(showSidebar).first().waitFor();
    if (await showSidebar.isVisible()) await showSidebar.click();
    await settings.click();
    }
    await page.getByRole("button", { name, exact: true }).click();
  } else {
    const destination = new URL(url);
    destination.searchParams.set("settings", Object.entries(appCopy.settings.sections).find(([, label]) => label === name)![0]);
    if (page.url().startsWith(url)) await page.getByRole("button", { name, exact: true }).click();
    else await page.goto(destination.href, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name, exact: true }).waitFor();
  }
  await page.setViewportSize({ width, height: 900 });
}

async function runLocale(locale: "ko" | "en") {
    setAppCopyLanguage(locale);
    const server = await createNativeAppServer({ uiRoot: resolve(before ? ".tmp/security-before-ui" : "packages/butler-app/client/ui/dist"), config: { user: { name: "Smoke", language: locale } }, env: { BUTLER_APP_FOREGROUND_LEASE: "0" } });
    const { secret } = JSON.parse(readFileSync(join(server.butlerData, "app/runtime/auth/local-admin.json"), "utf8"));
    const fixture = await seedApprovalFixture(server);
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    let refusal = "";
    let listState = "ready";
    const pendingLoads = new Set<() => void>();
    const releaseLoading = () => { for (const done of pendingLoads) done(); pendingLoads.clear(); };
    let always: GrantRecord[] | undefined;
    let rejectRevoke = false;
    let batchCalls = 0;
    const adminHeaders = { ...server.authHeaders, "x-butler-admin": secret };
    const routeApi = async (route: Route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.startsWith("/events")) { await route.continue(); return; }
      if (path === "/authority-permissions") console.log(`grants response ${locale} ${listState}`);
      if (path === "/authority-permissions" && listState !== "ready") {
        if (listState === "loading") await new Promise<void>(done => { pendingLoads.add(done); });
        if (listState === "error") { await route.fulfill({ status: 503, json: { error: { code: "authority_unavailable", message: "INTERNAL TEST MESSAGE" } } }); return; }
        if (listState === "empty") { await route.fulfill({ json: { data: { permissions: [] } } }); return; }
      }
      if (path === "/authority-permissions" && always) {
        await route.fulfill({ status: 200, json: { protocol_version: "butler.app.v1", data: { permissions: always } } }); return;
      }
      if (path === "/authority-permissions/revoke") {
        batchCalls++;
        if (rejectRevoke) { await route.fulfill({ status: 503, json: { error: { code: "authority_unavailable", message: "INTERNAL TEST MESSAGE" } } }); return; }
        if (always) {
          const revoked = new Set(route.request().postDataJSON().grants.map((grant: GrantRecord) => grant.grant_ref));
          always = always.filter(grant => !revoked.has(grant.grant_ref));
        }
      }
      const headers = path === "/settings" || path.startsWith("/security") && !refusal ? adminHeaders : server.authHeaders;
      await route.continue({ headers: { ...route.request().headers(), ...headers } });
    };
    async function configurePage() {
      await server.signIn(page);
      page.on("pageerror", error => console.error(`UI exception: ${error.message}`));
      page.on("response", response => { if (response.status() >= 400) console.log(`HTTP ${response.status()} ${new URL(response.url()).pathname}`); });
      await page.route(`${server.url}**`, routeApi);
    }
    await configurePage();
    // Each case has finished its assertions. Disarm canceled navigation callbacks before closing its context.
    async function freshPage(width: number) {
      releaseLoading();
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await page.goto("about:blank", { waitUntil: "commit" });
      await page.setViewportSize({ width, height: 900 });
      page.removeAllListeners("pageerror");
      page.removeAllListeners("response");
      await configurePage();
    }
    try {
      const listed = await server.api<{ permissions: GrantRecord[] }>("/authority-permissions");
      assert.equal(listed.permissions.length, 13);
      assert.equal(listed.permissions.filter(g => g.target === fixture.command).length, 2);
      assert(listed.permissions.some(g => g.session_title === "Files review"));
      for (const theme of ["light", "dark"]) for (const width of [1280, 375]) {
        await freshPage(width);
        await server.api("/settings", { method: "PATCH", headers: adminHeaders, body: JSON.stringify({ appearance_theme: theme }) });
        const key = `${locale}-${theme}-${width}`;
        console.log(`capture ${before ? "before" : "after"} ${key}`);
        await open(page, server.url, appCopy.settings.sections.general, width);
        if (!before) {
          const fields = await section(page, "conversation-input").locator('[data-setting-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute("data-setting-id")));
          assert.equal(fields.at(-1), "plan-mode-default");
          const toggle = section(page, "conversation-input").getByRole("switch", { name: appCopy.settings.fields.planModeDefault, exact: true });
          const previous = await toggle.getAttribute("aria-checked") === "true";
          await Promise.all([page.waitForResponse(response => response.url().endsWith("/settings") && response.request().method() === "PATCH"), toggle.click()]);
          assert.equal((await server.api<{ plan_mode_default: boolean }>("/settings")).plan_mode_default, !previous);
          await page.getByText(appCopy.settings.saved, { exact: true }).waitFor({ state: "visible" });
          await page.getByText(appCopy.settings.saved, { exact: true }).waitFor({ state: "hidden" });
        }
        await screenshot(page, key, "conversation-input");
        await open(page, server.url, appCopy.settings.sections.models, width);
        if (!before) assert.deepEqual(await sectionIds(page), ["butler-model", "backup-models", "advanced-models"]);
        await screenshot(page, key, "butler-model");
        if (before) { await screenshot(page, key, "saved-keys"); await screenshot(page, key, "permissions"); }
        await open(page, server.url, appCopy.settings.sections.security, width);
        if (!before) {
          await page.getByRole("button", { name: fixture.command, exact: true }).waitFor();
          await section(page, "grants").getByText(appCopy.settings.grants.targetUnknown, { exact: true }).waitFor();
          assert.equal(await rows(page).count(), 12, "dedupe across same-title conversations");
          assert.deepEqual(await sectionIds(page), ["remote-access", "permissions", "grants", "saved-keys", "diagnostics", "security-advanced"]);
          assert.equal(await section(page, "grants").getByText(appCopy.settings.grants.conversations(2), { exact: false }).count(), 1);
          await screenshot(page, key, "permissions"); await screenshot(page, key, "grants"); await screenshot(page, key, "diagnostics"); await screenshot(page, key, "saved-keys");
          const overflow = await section(page, "grants").evaluate(node => node.scrollWidth > node.clientWidth + 1);
          assert.equal(overflow, false, key);
          const target = page.getByRole("button", { name: /^src\/one.ts\s+src\/two.ts$/u });
          assert.equal(await target.getAttribute("aria-label"), "src/one.ts\nsrc/two.ts");
          await target.hover();
          await page.getByRole("tooltip").waitFor();
          assert.equal(await page.getByRole("tooltip").textContent(), "src/one.ts\nsrc/two.ts");
          await target.click(); assert.equal(await target.getAttribute("aria-expanded"), "true");
          assert((await target.textContent())?.includes("src/two.ts"));
          const search = page.getByRole("searchbox", { name: appCopy.settings.grants.search, exact: true });
          await search.fill("nonexistent"); await page.getByText(appCopy.settings.grants.noMatch, { exact: true }).waitFor();
          await search.fill("Files review"); assert.equal(await rows(page).count(), 4);
          await search.fill("");
          await page.getByRole("combobox", { name: appCopy.settings.grants.filter, exact: true }).selectOption("fileWrite");
          assert.equal(await rows(page).count(), 1);
          await page.getByRole("combobox", { name: appCopy.settings.grants.filter, exact: true }).selectOption("all");
        } else {
          await screenshot(page, key, "remote-access");
          await open(page, server.url, appCopy.settings.sections.privacy, width);
          await screenshot(page, key, "diagnostics");
        }
        await open(page, server.url, appCopy.settings.sections.security, width);
        const remote = section(page, "remote-access").getByRole("switch", { name: appCopy.settings.security.remoteAccess, exact: true });
        await remote.click();
        await section(page, "device-pairing").waitFor();
        await section(page, "security-advanced").getByRole("button").click();
        await section(page, "allowed-hosts").waitFor();
        if (!before) assert.deepEqual(await sectionIds(page), ["remote-access", "device-pairing", "paired-devices", "permissions", "grants", "saved-keys", "diagnostics", "security-advanced", "allowed-hosts"]);
        await screenshot(page, `${key}-enabled`, "remote-access");
        await screenshot(page, `${key}-enabled`, "allowed-hosts");
        await remote.click();
        await section(page, "device-pairing").waitFor({ state: "hidden" });
      }
      if (!before) {
        for (const code of ["loopback_required", "admin_credential_required", "test_error"]) {
          console.log(`refused ${locale} ${code}`);
          await freshPage(375);
          refusal = code;
          // Register the refusal before navigation, with a fixed response for this case.
          await page.route(`${server.url}security`, async route => {
            if (code === "admin_credential_required") await route.continue({ headers: { ...route.request().headers(), ...server.authHeaders } });
            else await route.fulfill({ status: code === "loopback_required" ? 403 : 500, json: { error: { code, message: "INTERNAL TEST MESSAGE" } } });
          });
          const denied = page.waitForResponse(response => new URL(response.url()).pathname === "/security");
          await open(page, server.url, appCopy.settings.sections.security, 375);
          assert.equal((await denied).status(), code === "test_error" ? 500 : 403);
          await page.getByRole("button", { name: fixture.command, exact: true }).waitFor();
          const refusedMessage = code === "loopback_required" ? appCopy.settings.security.hostOnly : code === "admin_credential_required" ? appCopy.settings.security.adminRequired : appCopy.settings.sectionState.error;
          await section(page, "remote-access").getByText(refusedMessage, { exact: true }).waitFor();
          assert.deepEqual(await sectionIds(page), ["remote-access", "permissions", "grants", "saved-keys", "diagnostics"]);
          await screenshot(page, `${locale}-refused-${code}`, "remote-access");
        }
        refusal = "";
        for (const state of ["loading", "error", "empty"]) {
          console.log(`grants state ${locale} ${state}`);
          await freshPage(1280);
          listState = state;
          await open(page, server.url, appCopy.settings.sections.security, 1280);
          const message = state === "loading" ? appCopy.settings.sectionState.loading : state === "error" ? appCopy.settings.grants.loadFailed : appCopy.settings.grants.empty;
          if (state === "loading") {
            await section(page, "grants").locator('[data-slot="settings-section-skeleton"]').waitFor();
          } else await section(page, "grants").getByText(message, { exact: true }).waitFor();
          if (state === "loading") { listState = "ready"; releaseLoading(); await rows(page).first().waitFor(); }
        }
        listState = "ready";
        console.log(`revoke ${locale}`);
        await open(page, `${server.url}?settings=privacy`, appCopy.settings.sections.security, 1280);
        await page.goto(`${server.url}?settings=privacy`, { waitUntil: "domcontentloaded" });
        await section(page, "permissions").waitFor();
        const navigationSearch = page.getByRole("searchbox", { name: appCopy.settings.searchLabel });
        await navigationSearch.fill(locale === "ko" ? "개인정보" : "privacy");
        await page.getByRole("button", { name: appCopy.settings.sections.security, exact: true }).waitFor();
        await navigationSearch.fill(locale === "ko" ? "API 키" : "API keys");
        assert.equal(await page.getByRole("button", { name: appCopy.settings.sections.security, exact: true }).count(), 1);
        await navigationSearch.fill("");
        const grouped = rows(page).filter({ has: page.getByRole("button", { name: fixture.command, exact: true }) });
        rejectRevoke = true;
        await grouped.getByRole("button", { name: appCopy.settings.grants.revoke, exact: true }).click();
        await page.getByText(appCopy.settings.grants.revokeFailed, { exact: true }).waitFor(); assert.equal(await grouped.count(), 1);
        rejectRevoke = false;
        const calls = batchCalls;
        await grouped.getByRole("button", { name: appCopy.settings.grants.revoke, exact: true }).click();
        await page.getByText(appCopy.settings.grants.revoked, { exact: true }).waitFor();
        assert.equal(batchCalls, calls + 1);
        const remaining = await server.api<{ permissions: GrantRecord[] }>("/authority-permissions");
        assert.equal(remaining.permissions.length, 11); assert(remaining.permissions.every(g => g.target !== fixture.command));
        // Reserved future scope: response fixture only, storage still conversation.
        for (const width of [375, 1280]) {
          console.log(`confirm ${locale} ${width}`);
          await freshPage(width);
          always = (await server.api<{ permissions: GrantRecord[] }>("/authority-permissions")).permissions;
          always[0].scope = "always";
          await page.goto(`${server.url}?settings=security`, { waitUntil: "domcontentloaded" });
          await section(page, "grants").getByText(appCopy.settings.grants.scope.always, { exact: true }).waitFor();
          const alwaysRow = rows(page).filter({ hasText: appCopy.settings.grants.scope.always });
          const oldCalls = batchCalls;
          await alwaysRow.getByRole("button", { name: appCopy.settings.grants.revoke, exact: true }).click();
          await page.getByRole("alertdialog").getByRole("button", { name: appCopy.common.cancel, exact: true }).click();
          assert.equal(batchCalls, oldCalls);
          await alwaysRow.getByRole("button", { name: appCopy.settings.grants.revoke, exact: true }).click();
          await screenshot(page, `${locale}-confirm-${width}`, "grants");
          await Promise.all([page.waitForResponse(response => response.url().endsWith("/authority-permissions/revoke")), page.getByRole("alertdialog").getByRole("button", { name: appCopy.settings.grants.revoke, exact: true }).click()]);
          assert.equal(batchCalls, oldCalls + 1);
          await alwaysRow.waitFor({ state: "hidden" });
        }
        assert.equal(await page.getByText("INTERNAL TEST MESSAGE", { exact: true }).count(), 0);
      }
      assert.equal(server.stubModelCalls.length, 0);
    } catch (error) { console.error(error); await page.screenshot({ path: join(output, `${locale}-failure.png`), animations: "allow", timeout: 10_000 }); console.error(error); throw error; }
    finally { releaseLoading(); try { await page.unrouteAll({ behavior: "ignoreErrors" }); await page.goto("about:blank", { waitUntil: "commit" }); await page.close(); } finally { await server.stop(); } }
}
try {
  for (const locale of ["ko", "en"] as const) await runLocale(locale);
  console.log(JSON.stringify({ ok: true, before, locales: ["ko", "en"], widths: [375, 1280], screenshots: screenshots.length, modelCalls: 0 }));
} finally { await browser.close(); }
