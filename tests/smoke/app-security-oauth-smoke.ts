// test-category: security
// Real UI -> isolated native gateway -> local OAuth authority, with fake tokens only.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import type { Page } from "playwright";
import { appCopy, getAppLocale, setAppCopyLanguage } from "../../packages/butler-app/client/ui/src/app/copy";
import { createOauthSmokeServer, oauthAccountName } from "../support/security-oauth";
import { launchSmokeBrowser } from "../support/smoke-browser";

const language = process.env.OAUTH_SMOKE_LANGUAGE ?? "en";
setAppCopyLanguage(language);
const section = (page: Page) => page.locator('[data-settings-section-id="connected-accounts"]');

async function run(revokeStatus: number) {
  const fixture = await createOauthSmokeServer(language, revokeStatus);
  const { server, adminHeaders } = fixture;
  let browser;
  try {
    browser = await launchSmokeBrowser();
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const copy = appCopy.settings.connectedAccounts;
    let catalogReads = 0;
    let accountReads = 0;
    page.on("response", response => {
      const path = new URL(response.url()).pathname;
      if (path === "/model-catalog") catalogReads++;
      if (path === "/setup/chatgpt-account") accountReads++;
    });
    await page.route(`${server.url}**`, route => route.continue({
      headers: { ...route.request().headers(), ...adminHeaders },
    }));
    await page.goto(server.url);
    await page.getByRole("button", { name: appCopy.sidebar.settings, exact: true }).click();
    await page.getByRole("button", { name: appCopy.settings.sections.security, exact: true }).click();
    await section(page).getByText(oauthAccountName, { exact: true }).waitFor();
    await section(page).getByText(copy.kind.sign_in, { exact: true }).waitFor();
    const obtained = await page.evaluate(locale => new Intl.DateTimeFormat(locale, { dateStyle: "short" })
      .format(new Date("2026-10-20T03:00:00Z")), getAppLocale());
    await section(page).getByText(copy.obtained(obtained), { exact: true }).waitFor();
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await section(page).evaluate(node => node.scrollWidth > node.clientWidth + 1), false, `Account section fits ${width}px`);
    }
    const button = section(page).getByRole("button", { name: copy.signOutOf(oauthAccountName), exact: true });
    await button.click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByText(copy.confirm(oauthAccountName), { exact: true }).waitFor();
    await dialog.getByRole("button", { name: appCopy.common.cancel, exact: true }).click();
    assert.equal(fixture.revocations(), 0, "cancel keeps the credential");
    await button.click();
    const reads = { catalog: catalogReads, account: accountReads };
    const catalogRefreshed = page.waitForResponse(response => new URL(response.url()).pathname === "/model-catalog").catch(error => error);
    const removed = page.waitForResponse(response => response.request().method() === "DELETE" && new URL(response.url()).pathname.startsWith("/security/oauth/"));
    fixture.holdRevocation();
    await dialog.getByRole("button", { name: copy.signOut, exact: true }).click();
    await page.waitForFunction(label => {
      const button = [...document.querySelectorAll("button")].find(node => node.getAttribute("aria-label") === label);
      return button?.disabled;
    }, copy.signOutOf(oauthAccountName));
    fixture.releaseRevocation();
    const response = await removed;
    assert.equal(response.status(), 200, "credential removal succeeds");
    const body = await response.json();
    assert.equal(body.data?.removed, true, "credential removed");
    assert.equal(body.data?.revoked, revokeStatus === 200, "revocation result matches the authority");
    await page.getByText(revokeStatus === 200 ? copy.done : copy.revokeUnconfirmed, { exact: true }).waitFor();
    if (revokeStatus !== 200) assert.equal(await page.getByText(copy.done, { exact: true }).count(), 0, "one unconfirmed toast");
    await section(page).getByText(copy.empty, { exact: true }).waitFor();
    assert.equal(await section(page).getByRole("button").count(), 0, "empty section has no account row");
    assert(fixture.revocations() > 0, "authority received the revoke");
    const saved = JSON.parse(readFileSync(fixture.registration, "utf8"));
    assert.equal(saved.access_token === null, true, "saved access token cleared");
    assert.equal(saved.refresh_token === null, true, "saved refresh token cleared");
    const account = await server.api<{ status: string }>("/setup/chatgpt-account");
    assert.notEqual(account.status, "signed_in");
    await catalogRefreshed;
    // Settings unmounts the composer account view; returning must read signed-out state.
    const accountRefreshed = page.waitForResponse(response => new URL(response.url()).pathname === "/setup/chatgpt-account");
    await page.getByRole("button", { name: appCopy.settings.back, exact: true }).click();
    const current = await (await accountRefreshed).json();
    assert.notEqual(current.data?.status, "signed_in", "returning account view reads signed-out state");
    assert(catalogReads > reads.catalog, "model catalog refreshed after removal");
    assert(accountReads > reads.account, "mounted account views refreshed after removal");
    assert.equal(server.stubModelCalls.length, 0, "sign-out uses no model calls");
    console.log(JSON.stringify({ ok: true, language, revokeStatus, revocations: fixture.revocations(), widths: [390, 1280] }));
  } catch (error) {
    console.error(fixture.redact(String(error)));
    process.exitCode = 1;
  } finally {
    fixture.releaseRevocation();
    try { await browser?.close(); } finally { await fixture.stop(); }
  }
}

await run(200);
if (!process.exitCode) await run(503);
