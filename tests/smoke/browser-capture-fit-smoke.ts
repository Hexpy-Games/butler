// test-category: race
/** Actual browser picks → composer admission → persisted sent thumbnail fit. Stub only. */
import { getAppCopy } from "../../packages/butler-i18n/src/index";
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { redesignApp } from "../support/browser-redesign-app";
import { waitBrowser } from "../support/browser-agent-app";
import { nativeAligned } from "../support/browser-shell-acceptance";
import { sendBrowserCaptures } from "../support/browser-selection-send";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE;
assert.ok(evidence);
mkdirSync(evidence, { recursive: true });
process.env.BUTLER_SMOKE_ELECTRON_EXECUTABLE ??= createRequire(resolve("packages/butler-app/client/electron/package.json"))("electron") as string;
const app = await redesignApp(evidence);
try {
  await app.click(getAppCopy("en-US").space.general);
  await app.call("open");
  const tab = await app.call<string>("create", { owner: "conversation:general", profile: "signed_out", url: app.url });
  await app.click("Show browser");
  await app.call("activate", { id: tab });
  await nativeAligned(app);
  const subject = `globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab)})`;
  await waitBrowser(() => app.main(`${subject}.status === 'idle' && ${subject}.view.webContents.getTitle() === 'Browser fixture'`), "fixture loaded");
  await app.call("pick", { id: tab, value: true });
  await waitBrowser(() => app.main("Boolean(globalThis.browserAgentSubject.pointer.view && globalThis.browserAgentSubject.pointer.ready)"), "pick overlay ready");
  for (const [index, selector] of ["h1", "p"].entries()) {
    const point = await app.main<{ x: number; y: number }>(`${subject}.view.webContents.executeJavaScript(${JSON.stringify(`(()=>{const r=document.querySelector('${selector}').getBoundingClientRect();return {x:r.x+24,y:r.y+r.height/2}})()`)})`);
    const scale = await app.main<number>(`${subject}.bounds.scale ?? 1`);
    await app.main(`(()=>{const p=globalThis.browserAgentSubject.pointer.view.webContents;
      p.sendInputEvent({type:'mouseDown',x:${Math.round(point.x * scale)},y:${Math.round(point.y * scale)},button:'left',clickCount:1});
      p.sendInputEvent({type:'mouseUp',x:${Math.round(point.x * scale)},y:${Math.round(point.y * scale)},button:'left',clickCount:1});})()`);
    await waitBrowser(() => app.main(`(${subject}.selections?.length ?? 0) === ${index + 1}`), "browser pick captured");
  }
  await app.call("selection-command", { id: tab, op: "attach" });
  await waitBrowser(() => app.page.expression("document.querySelectorAll('[data-slot=element-chip]').length===2"), "capture attachment persisted before reload");
  await app.click("Hide browser");
  await sendBrowserCaptures(app, tab, evidence, async name => {
    // The sent-message renderer is the subject; no native pane is included in this capture.
    await app.page.expression("document.fonts.ready.then(()=>Promise.all([...document.querySelectorAll('article img')].map(img=>img.decode())))");
    writeFileSync(join(evidence, `${name}.png`), await app.page.screenshot());
  });
  console.log("PASS browser capture fit: light/dark, uploaded photo and wide picks, persisted reload, provider image admission");
} catch (error) {
  writeFileSync(join(evidence, "failure.png"), await app.page.screenshot());
  throw error;
} finally { await app.stop(); }
