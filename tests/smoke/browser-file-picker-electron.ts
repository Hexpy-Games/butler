// test-category: security
/** Localized DS picker and the real FileReader → page FileList path. */
import { strict as assert } from "node:assert";
import { join, resolve } from "node:path";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence);
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() {
  return new Response(Bun.file(resolve("tests/fixtures/browser/S4/index.html")), { headers: { "content-type": "text/html" } });
} });
const app = await browserAgentApp(evidence, () => null);
try {
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "en", appearance_theme: "light" }) });
  await app.page.reload(); await app.click("Browser");
  const id = await app.call<string>("create", { url: server.url.href });
  const contents = `globalThis.browserAgentSubject.tabs.get(${JSON.stringify(id)}).view.webContents`;
  await waitBrowser(() => app.main(`${contents}.executeJavaScript("Boolean(document.querySelector('#upload'))")`), "file fixture loaded");
  for (const locale of ["ko", "en"]) for (const theme of ["light", "dark"]) for (const width of [1440, 1100]) {
    await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language: locale, appearance_theme: theme }) });
    await app.main(`${app.win}.setContentSize(${width},900)`); await app.page.reload();
    await app.click(locale === "ko" ? "브라우저" : "Browser"); await app.call("activate", { id });
    await app.main(`(()=>{void ${contents}.executeJavaScript("document.querySelector('#upload').click()")})()`);
    await app.page.waitForFunction(() => Boolean(document.querySelector('[data-test-class="browser-page-dialog"] input[type=file]')));
    assert.equal(await app.main(`${contents}.debugger.isAttached()`), false);
    assert.equal(await app.main(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(id)}).attached===null`), true);
    const name = `${locale}-${theme}-${width}`;
    await app.shot(`${name}-file`);
    await app.page.expression(`(()=>{const input=document.querySelector('[data-test-class="browser-page-dialog"] input[type=file]'),transfer=new DataTransfer();transfer.items.add(new File(['fixture bytes'],'fixture.txt',{type:'text/plain'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await app.page.waitForFunction(() => document.querySelector('[data-test-class="browser-page-dialog"]')?.textContent?.includes("fixture.txt"));
    await app.shot(`${name}-file-selected`);
    await app.click(locale === "ko" ? "확인" : "OK");
    await app.page.waitForFunction(() => !document.querySelector('[data-test-class="browser-page-dialog"]'));
    assert.equal(await app.main(`${contents}.executeJavaScript("document.querySelector('#upload').files[0].text()")`), "fixture bytes");
  }
  await Bun.write(join(evidence, "acceptance-file-picker.json"), JSON.stringify({ status: "passed", cells: 8, fileBytes: 13 }));
} finally { server.stop(true); await app.stop(); }
