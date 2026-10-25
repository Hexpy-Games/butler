/** Stub-created HTML through real delivery, artifact cards and Library. */
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Browser, Page } from "playwright";
import { verifyBrowserHtmlRefresh } from "./html-artifact-client-smoke";
import { appCopy } from "../../packages/butler-app/client/ui/src/app/copy.ts";
import type { NativeAppServerHandle } from "./native-app-server";

export async function htmlArtifactSmoke(server: NativeAppServerHandle, browser: Browser, baseline: boolean, sessionId: string, sessionTitle: string) {
  const evidence = process.env.BUTLER_SMOKE_SCREENSHOTS;
  if (evidence) mkdirSync(evidence, { recursive: true });
  const html = htmlArtifactFixture(new URL(server.url).origin);
  const { artifacts } = await server.api<{ artifacts: Array<{ title: string; url: string; signed_url: string }> }>(`/artifacts?session_id=${sessionId}`);
  const file = artifacts.find(item => item.title === "standalone.HTML");
  assert.ok(file, "stub-created HTML was delivered as an artifact");
  const original = await fetch(new URL(file.signed_url, server.url));
  const headers = Object.fromEntries(original.headers);
  assert.equal(await original.text(), html, "source bytes retained");
  if (!baseline) {
    const legacy = new URL(file.signed_url, server.url); legacy.searchParams.set("render", "html");
    const inert = await fetch(legacy, { redirect: "manual" });
    assert.equal(inert.status, 200, "legacy render query never redirects a frame through the gateway");
    assert.equal(inert.headers.get("content-security-policy"), "sandbox; default-src 'none'");
    assert.equal(await fetch(new URL(`${file.url}/view`, server.url)).then(response => response.status), 401);
  }
  if (evidence) writeFileSync(join(evidence, `${baseline ? "before" : "after"}-headers.json`), JSON.stringify(headers, null, 2));
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  try {
    await server.signIn(page); await page.goto(server.url);
    const showSidebar = page.getByRole("button", { name: appCopy.titlebar.showLeftPanel, exact: true });
    await showSidebar.or(page.getByRole("button", { name: appCopy.titlebar.hideLeftPanel, exact: true })).waitFor();
    if (await showSidebar.isVisible()) await showSidebar.click();
    await page.locator('[data-test-class="app-sidebar"]').getByText(sessionTitle, { exact: true }).click();
    await page.locator('[data-test-class="message-artifact-list"]').getByText("standalone.HTML", { exact: true }).click();
    await verify(page, "file-card");
    // The file viewer holds the right slot; close it and open the same file from 세션 정보's results.
    await page.locator('[data-test-class="file-viewer-close"]').click();
    await page.locator('[data-test-class="file-viewer"]').waitFor({ state: "detached" });
    if (await page.locator('[data-test-class="session-info-toggle"]').getAttribute("aria-pressed") !== "true") await page.locator('[data-test-class="session-info-toggle"]').click();
    await page.locator('[data-slot="document-tile"]').getByText("standalone.HTML", { exact: true }).click();
    await verify(page, "preview-panel");
    // Close it again, so only the 서랍 entry can bring the file back into the viewer.
    await page.locator('[data-test-class="file-viewer-close"]').click();
    await page.locator('[data-test-class="file-viewer"]').waitFor({ state: "detached" });
    await page.getByRole("button", { name: appCopy.library.title, exact: true }).click();
    await page.locator('[data-library-kind="document"]').getByText("standalone.HTML", { exact: true }).click();
    await page.locator('[data-test-class="file-viewer"]').waitFor();
    await verify(page, "library");
    if (!baseline) {
      const frame = page.frames().find(frame => frame.url().includes("/__o/"))!;
      assert.ok(frame);
      const response = await fetch(frame.url());
      if (evidence) writeFileSync(join(evidence, "after-render-headers.json"), JSON.stringify(Object.fromEntries(response.headers), null, 2));
      assert.match(response.headers.get("content-type")!, /^text\/html/);
      assert.match(response.headers.get("content-security-policy")!, /sandbox allow-scripts/);
      assert.notEqual(new URL(frame.url()).origin, new URL(server.url).origin);
      // The content listener has no gateway API routes.
      assert.equal(await fetch(new URL("/settings", frame.url())).then(r => r.status), 404);
      assert.equal(await fetch(new URL(new URL(frame.url()).pathname, server.url), { headers: server.authHeaders }).then(r => r.status), 404);
      const tab = await browser.newPage();
      try {
        await tab.goto(frame.url());
        await tab.locator("#html-output").waitFor();
        await tab.locator("body[data-ready=yes][data-api=blocked]").waitFor();
        if (evidence) await tab.screenshot({ path: join(evidence, "after-browser-page.png") });
      } finally { await tab.close(); }
      assert.equal(await fetch(frame.url().replace(/\/__o\/[^/]+\//, "/__o/invalid/")).then(r => r.status), 403);
    }
  } catch (error) {
    if (evidence) await page.screenshot({ path: join(evidence, `${baseline ? "before" : "after"}-failure.png`) }).catch(() => {});
    if (evidence) writeFileSync(join(evidence, "html-failure.txt"), await page.locator("body").innerText().catch(() => "unavailable"));
    throw error;
  } finally { await page.close(); }

  async function verify(page: Page, entry: string) {
    const viewer = page.locator('[data-test-class="artifact-viewer"]');
    if (baseline) { await viewer.locator("pre").filter({ hasText: "<!doctype html>" }).waitFor(); }
    else {
      const frame = page.frameLocator('[data-test-class="artifact-viewer"] iframe');
      await frame.locator("#html-output").filter({ hasText: "HTML artifact rendered" }).waitFor();
      await frame.locator("body[data-ready=yes][data-api=blocked]").waitFor();
      await frame.getByRole("button", { name: "Interactive", exact: true }).click();
      await frame.getByRole("button", { name: "Clicked", exact: true }).waitFor();
      const child = page.frames().find(frame => frame.url().includes("/__o/"))!;
      if (entry === "file-card") await verifyBrowserHtmlRefresh(page, server, sessionId);
      assert.equal(await child.evaluate(() => localStorage.getItem("html-preview")), "ready");
      assert.deepEqual(await child.evaluate(() => ({ node: typeof (globalThis as unknown as { require?: unknown }).require, ipc: typeof (window as unknown as { butlerApp?: unknown }).butlerApp, parent: (() => { try { return Boolean(parent.document); } catch { return false; } })() })), { node: "undefined", ipc: "undefined", parent: false });
    }
    if (evidence) await page.screenshot({ path: join(evidence, `${baseline ? "before" : "after"}-${entry}.png`) });
  }
}

/** Standalone interactive file produced by the smoke provider. */
export function htmlArtifactFixture(origin: string) {
  return `<!doctype html><meta charset=utf-8><style>body{background:#eef4ff;color:#17335e;padding:24px}button{padding:12px}</style><h1 id=html-output>HTML artifact rendered</h1><button onclick="this.textContent='Clicked'">Interactive</button><script>localStorage.setItem('html-preview','ready');document.body.dataset.ready='yes';fetch('${origin}/settings').then(()=>document.body.dataset.api='allowed').catch(()=>document.body.dataset.api='blocked')</script>`;
}
