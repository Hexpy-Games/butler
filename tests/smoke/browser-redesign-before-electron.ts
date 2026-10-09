/** Read-only origin/main UI + Electron visual baseline; explicit exported build required. */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redesignApp } from "../support/browser-redesign-app";
import { describeBrowser, bridgeBrowser } from "../support/browser-agent-stub";
import { holdObservation } from "../support/browser-control-actions";
import { waitBrowser } from "../support/browser-agent-app";
import { nativeAligned } from "../support/browser-shell-acceptance";
const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence);
assert.ok(process.env.BUTLER_SMOKE_ELECTRON_APP); assert.ok(process.env.BUTLER_SMOKE_RENDERER_DIST);
mkdirSync(evidence, { recursive: true });
const app = await redesignApp(evidence);
const shots: string[] = [];
try {
  app.stub.set([describeBrowser, () => bridgeBrowser("browser_open", { url: app.url })]);
  await app.send("Open baseline browser fixture"); await app.delivered();
  const state = await app.call<{ tabs: Array<{ id: string; agent: boolean }> }>("state");
  const tab = state.tabs.find(item => item.agent)!.id; assert.ok(tab);
  const mine = await app.call<string>("create", { url: app.url });
  for (const language of ["ko", "en"]) for (const theme of ["light", "dark"]) for (const width of [1440, 1100]) {
    await app.settings(language, theme, width);
    if (await app.page.expression("document.querySelector('[data-test-class=mac-window]').getAttribute('data-left-open') === 'false'")) await app.click(language === "ko" ? "사이드바 보기" : "Show sidebar");
    await app.click(language === "ko" ? "브라우저" : "Browser"); await nativeAligned(app);
    await app.call("activate", { id: tab });
    const prefix = `${language}-${theme}-${width}`;
    const shot = async (name: string) => { await app.shot(`${prefix}-${name}`); shots.push(`${prefix}-${name}`); };
    await shot("hub");
    await waitBrowser(() => app.page.expression(`document.querySelector('[data-slot=titlebar-leading] button')?.textContent.trim() === ${JSON.stringify(language === "ko" ? "일반" : "General")}`), "baseline owner button");
    await app.page.clickSelector('[data-slot=titlebar-leading] button');
    await waitBrowser(() => app.page.expression("Boolean(document.querySelector('[data-slot=adaptive-shell-split-chat]'))"), "baseline conversation frame"); await nativeAligned(app);
    await app.call("control", { id: tab, holder: "agent" }); await app.internal("tabs.list"); await shot("agent");
    const release = await holdObservation(app, tab); await shot("busy"); await release();
    await app.internal("tab.waiting", tab, { value: true }); await shot("waiting");
    await app.call("control", { id: tab, holder: "user", sticky: true }); await shot("direct");
    await app.call("control", { id: tab, holder: "agent" });
    if (await app.page.expression("document.querySelector('[data-test-class=mac-window]').getAttribute('data-left-open') === 'false'")) await app.click(language === "ko" ? "사이드바 보기" : "Show sidebar");
    await app.click(language === "ko" ? "브라우저" : "Browser"); await nativeAligned(app); await app.call("activate", { id: mine }); await shot("none");
  }
  writeFileSync(join(evidence, "result.json"), JSON.stringify({ ok: true, source: "origin/main", shots }));
} finally { await app.stop(); }
