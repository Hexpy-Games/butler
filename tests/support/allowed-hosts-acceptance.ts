/** SecuritySettings product UI with a deterministic settings transport. */
import { strict as assert } from "node:assert";
import { join } from "node:path";
import type { Browser, Locator, Page } from "playwright";
import { getAppCopy } from "../../packages/butler-i18n/src";

async function settledInput(input: Locator) {
  await input.page().waitForFunction(id => {
    const field = document.getElementById(id!) as HTMLInputElement | null;
    return field && !field.disabled && field.value === "";
  }, await input.getAttribute("id"));
}

async function addWhileBusy(panel: Locator, input: Locator, url: string) {
  const page = input.page();
  let entered!: () => void;
  let release!: () => void;
  let completed!: () => void;
  const requested = new Promise<void>(done => { entered = done; });
  const handled = new Promise<void>(done => { completed = done; });
  const held = new Promise<void>(done => { release = done; });
  await page.route(`${url}/settings`, async route => {
    entered(); await held; await route.continue(); completed();
  });
  try {
    await input.fill("two.example.com"); await input.press("Enter"); await requested;
    await panel.locator("input:disabled").first().waitFor();
    assert.equal(await panel.locator("input:not(:disabled), button:not(:disabled)").count(), 0, "all host controls disabled while saving");
  } finally { release(); await handled; await page.unroute(`${url}/settings`); }
}

async function screenshot(page: Page, output: string, key: string) {
  const section = key.startsWith("before-") && key.endsWith("-expanded") ? "allowed-hosts" : "security-advanced";
  await page.locator(`[data-settings-section-id="${section}"]`).scrollIntoViewIfNeeded();
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.screenshot({ path: join(output, `${key}.png`), animations: "disabled" });
}

export async function captureAllowedHosts(browser: Browser, url: string, output: string, enabled: boolean) {
  const before = process.env.BUTLER_ALLOWED_HOSTS_BEFORE === "1";
  for (const locale of ["ko", "en"]) for (const theme of ["light", "dark"]) for (const width of [1440, 375]) {
    if (process.env.BUTLER_ALLOWED_HOSTS_CELL && process.env.BUTLER_ALLOWED_HOSTS_CELL !== `${enabled}-${locale}-${theme}-${width}`) continue;
    console.log(`Allowed hosts cell ${enabled} ${locale} ${theme} ${width}`);
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const saves: string[][] = [];
    page.on("request", request => {
      if (request.method() === "PATCH" && new URL(request.url()).pathname === "/settings") {
        saves.push(request.postDataJSON().security.allowed_hosts);
      }
    });
    page.on("pageerror", error => console.error(error.message));
    page.on("response", response => { if (new URL(response.url()).pathname === "/settings") console.log("Settings fixture response", response.status()); });
    page.on("crash", () => console.error("Allowed hosts browser page crashed"));
    const copy = getAppCopy(locale === "ko" ? "ko-KR" : "en-US").settings.security;
    const key = `${before ? "before" : "after"}-${enabled ? "on" : "off"}-${locale}-${theme}-${width}`;
    try {
      await page.goto(`${url}/?locale=${locale}&theme=${theme}&state=security`);
      const row = page.locator('[data-test-class="settings-security-advanced"]');
      const toggle = row.getByRole("button").or(row.locator("button")).first();
      await toggle.waitFor();
      assert.equal(await toggle.getAttribute("aria-expanded"), "false");
      await screenshot(page, output, `${key}-collapsed`);
      await toggle.click();
      await page.getByText("one.example.com", { exact: true }).waitFor();
      await screenshot(page, output, `${key}-expanded`);
      if (before) continue;
      const panelId = await toggle.getAttribute("aria-controls");
      assert(panelId, "disclosure controls its panel");
      const panel = page.locator(`[id="${panelId}"]`);
      assert.equal(await panel.count(), 1);
      assert.equal(await page.locator('[data-settings-section-id="allowed-hosts"]').count(), 0);
      await row.getByText(copy.hostCount(1), { exact: true }).waitFor();
      const input = panel.getByRole("textbox", { name: copy.hosts, exact: true });
      assert(await input.getAttribute("aria-describedby"), "input has its description");
      assert.equal(await panel.getByRole("textbox", { name: copy.contentHosts, exact: true }).count(), enabled ? 1 : 0);
      await addWhileBusy(panel, input, url);
      await panel.getByText("two.example.com", { exact: true }).waitFor();
      await row.getByText(copy.hostCount(2), { exact: true }).waitFor();
      await settledInput(input);
      await input.fill("two.example.com"); await panel.getByRole("button", { name: copy.addHost, exact: true }).first().click();
      assert.equal(await input.inputValue(), "", "duplicate clears the draft");
      await panel.getByRole("button", { name: copy.removeHost("two.example.com"), exact: true }).click();
      await panel.getByText("two.example.com", { exact: true }).waitFor({ state: "detached" });
      await row.getByText(copy.hostCount(1), { exact: true }).waitFor();
      await panel.getByRole("button", { name: copy.removeHost("one.example.com"), exact: true }).click();
      await row.getByText(copy.hostCount(0), { exact: true }).waitFor();
      assert.equal(await panel.getByText(copy.hostCount(0), { exact: true }).count(), 0);
      await input.fill("one.example.com"); await panel.getByRole("button", { name: copy.addHost, exact: true }).first().click();
      await row.getByText(copy.hostCount(1), { exact: true }).waitFor();
      await settledInput(input);
      assert.equal(await panel.evaluate(node => node.scrollWidth > node.clientWidth + 1), false, key);
      assert.deepEqual(saves, [["one.example.com", "two.example.com"], ["one.example.com"], [], ["one.example.com"]], "whole lists saved; duplicate does not save");
      await toggle.click(); assert.equal(await toggle.getAttribute("aria-expanded"), "false");
      await page.reload(); assert.equal(await toggle.getAttribute("aria-expanded"), "false", "open state is not persisted");
    } catch (error) {
      console.error("Saved lists before failure", JSON.stringify(saves));
      await page.screenshot({ path: join(output, `${key}-failure.png`) });
      throw error;
    } finally { await page.close(); }
  }
  console.log(`Allowed hosts ${before ? "before captures" : "acceptance"}: browser=${enabled}, ${process.env.BUTLER_ALLOWED_HOSTS_CELL ? 1 : 8} cells`);
}
