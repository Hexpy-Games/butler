import { strict as assert } from "node:assert";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import type { Page, Response } from "playwright";
import { electronFrame, type ElectronPage } from "./electron-page-cdp";
import type { NativeAppServerHandle } from "./native-app-server";

const refreshMarker = "Refresh artifact file URLs";
const frameSelector = '[data-test-class="artifact-viewer"] iframe';

/** Real live-session reconciliation re-signs file links while the viewer stays open. */
export async function refreshHtmlFileUrls(server: NativeAppServerHandle, sessionId: string) {
  const path = `/artifacts?session_id=${sessionId}`;
  const before = await server.api<{ artifacts: Array<{ title: string; signed_url?: string }> }>(path);
  const signed = before.artifacts.find(file => file.title === "standalone.HTML")?.signed_url;
  assert.ok(signed);
  const expires = new URL(signed, server.url).searchParams.get("expires")!;
  // Wait for a different signing second, not a reload debounce or a test retry.
  await new Promise(done => setTimeout(done, Math.max(0, (Number(expires) - 600 + 1) * 1000 - Date.now())));
  const marker = `${refreshMarker} ${crypto.randomUUID()}`;
  await server.api("/messages", { method: "POST", body: JSON.stringify({ chat_id: sessionId, text: marker, client_message_id: crypto.randomUUID() }) });
  const after = await server.api<typeof before>(path);
  assert.notEqual(after.artifacts.find(file => file.title === "standalone.HTML")?.signed_url, signed);
  return marker;
}

export async function verifyBrowserHtmlRefresh(page: Page, server: NativeAppServerHandle, sessionId: string) {
  const child = page.frames().find(frame => frame.url().includes("/__o/"))!;
  const src = await page.locator(frameSelector).getAttribute("src");
  const loadId = await child.evaluate(() => {
    const body = document.body;
    body.dataset.loadId = String(Math.random());
    return body.dataset.loadId;
  });
  if (process.env.BUTLER_SMOKE_SCREENSHOTS) await page.screenshot({ path: join(process.env.BUTLER_SMOKE_SCREENSHOTS, `before-url-refresh-${new URL(page.url()).protocol.replace(":", "")}.png`) });
  const response = page.waitForResponse(response => new URL(response.url()).pathname === "/session-view");
  // Every session view the client reads from here on, so a phone (no chat on screen) can still prove it applied the refresh.
  const views: Promise<string>[] = [];
  const collect = (read: Response) => { if (new URL(read.url()).pathname === "/session-view") views.push(read.text().catch(() => "")); };
  page.on("response", collect);
  const marker = await refreshHtmlFileUrls(server, sessionId);
  await response;
  if (await page.locator('[data-test-class~="conversation"]').count()) await page.getByText(marker, { exact: true }).last().waitFor();
  else await waitFor(async () => (await Promise.all(views)).some(text => text.includes(marker)), "the client read the refreshed session view");
  page.off("response", collect);
  assert.equal(await page.locator(frameSelector).getAttribute("src"), src);
  assert.equal(await child.evaluate(() => document.body.dataset.loadId), loadId);
  await page.frameLocator(frameSelector).getByRole("button", { name: "Clicked", exact: true }).waitFor();
}

async function waitFor(check: () => Promise<boolean>, label: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    assert(Date.now() < deadline, `timed out: ${label}`);
    await new Promise(done => setTimeout(done, 100));
  }
}

/** Same production app://butler preload boundary as the published-output smoke. */
export async function verifyElectronHtml(page: ElectronPage, port: number, server: NativeAppServerHandle, sessionId: string, language: string) {
  await page.clickText("standalone.HTML", '[data-test-class="message-artifact-list"] *');
  const origin = new URL(server.url); origin.port = String(server.port + 1);
  const deadline = Date.now() + 30_000;
  const child: { current: ElectronPage | null } = { current: null };
  const evaluate = async <T>(expression: string) => {
    child.current ??= await electronFrame(port, origin.origin);
    return child.current ? child.current.expression<T>(expression) : page.frameExpression<T>(origin.origin, expression);
  };
  try {
    while (true) {
      const ready = await evaluate<boolean>("document.querySelector('#html-output')?.textContent === 'HTML artifact rendered' && document.body.dataset.api === 'blocked'").catch(() => false);
      if (ready) break;
      assert(Date.now() < deadline, "Electron HTML artifact rendered");
      await new Promise(done => setTimeout(done, 100));
    }
    assert.deepEqual(await evaluate("({preload:typeof window.butlerApp,node:typeof require,parent:(()=>{try{return Boolean(parent.document)}catch{return false}})()})"), { preload: "undefined", node: "undefined", parent: false });
    const loadId = await evaluate<string>("(document.querySelector('button').click(),document.body.dataset.loadId=crypto.randomUUID())");
    const src = await page.expression<string>(`document.querySelector('${frameSelector}').src`);
    const marker = await refreshHtmlFileUrls(server, sessionId);
    const refreshed = Date.now() + 30_000;
    while (!await page.expression<boolean>(`document.body.innerText.includes(${JSON.stringify(marker)})`)) {
      assert(Date.now() < refreshed, "Electron received the refreshed session view");
      await new Promise(done => setTimeout(done, 100));
    }
    assert.equal(await page.expression(`document.querySelector('${frameSelector}').src`), src);
    assert.deepEqual(await evaluate("({loadId:document.body.dataset.loadId,button:document.querySelector('button').textContent})"), { loadId, button: "Clicked" });
    if (process.env.BUTLER_SMOKE_SCREENSHOTS) writeFileSync(join(process.env.BUTLER_SMOKE_SCREENSHOTS, `after-electron-html-${language}.png`), await page.screenshot());
    console.log(`Electron HTML artifact ${language}: render, refreshed URLs, retained state, preload/Node/parent isolation passed`);
  } finally { child.current?.close(); }
}
