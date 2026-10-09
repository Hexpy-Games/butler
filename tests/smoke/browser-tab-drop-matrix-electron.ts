// test-category: security
/** S2 sidebar feedback matrix in the final S3 App, with actual pointer drops. */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redesignApp } from "../support/browser-redesign-app";
import { waitBrowser } from "../support/browser-agent-app";
import { nativeAligned } from "../support/browser-shell-acceptance";
const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence); mkdirSync(evidence, { recursive: true });
const app = await redesignApp(evidence);
const results: string[] = [];
try {
  const destination = await app.gateway.api<{ session: { id: string } }>("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title: "Destination" }) });
  await app.call("open");
  const tab = await app.call<string>("create", { owner: "conversation:general", profile: "signed_out", url: app.url });
  for (const language of ["ko", "en"]) for (const theme of ["light", "dark"]) for (const width of [1440, 1100]) {
    await app.call("move", { tabId: tab, toGroupId: "conversation:general", index: 0 });
    await app.settings(language, theme, width);
    const showSidebar = async () => {
      if (await app.page.expression("document.querySelector('[data-test-class=mac-window]').getAttribute('data-left-open') === 'false'")) await app.click(language === "ko" ? "사이드바 보기" : "Show sidebar");
    };
    await showSidebar(); await app.click(language === "ko" ? "브라우저" : "Browser"); await nativeAligned(app);
    await app.page.clickSelector('[data-slot="titlebar-leading"] button');
    await waitBrowser(() => app.page.expression("Boolean(document.querySelector('[data-slot=adaptive-shell-split-chat]'))"), "conversation frame mounted");
    await nativeAligned(app);
    await app.page.expression(`(()=>{window.browserDropTrace=[];for(const type of ['pointerdown','pointermove','pointerup','pointercancel'])document.addEventListener(type,event=>window.browserDropTrace.push({type:event.type,x:event.clientX,y:event.clientY,buttons:event.buttons,outside:Boolean(document.querySelector('[data-drop=outside]'))}),true)})()`);
    const from = await app.page.expression<{ x: number; y: number }>("(()=>{const r=document.querySelector('[data-slot=tab-strip] [role=tab]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
    await app.page.pointerDown(from.x, from.y); await app.page.dragPointer(from.x + 10, from.y);
    if (await app.page.expression("document.querySelector('[data-test-class=mac-window]').getAttribute('data-left-open') === 'false'")) {
      await app.page.dragPointer(2, 400);
      await waitBrowser(() => app.page.expression("Boolean(document.querySelector('[data-left-peek=true]'))"), "drag opens collapsed sidebar peek");
    }
    await waitBrowser(() => app.page.expression(`(()=>{const row=document.querySelector('[data-tree-item="s:${destination.session.id}"] [data-test-class~="tree-row"]');const r=row?.getBoundingClientRect();return r && row.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`), "visible sidebar conversation row");
    const to = await app.page.expression<{ x: number; y: number }>(`(()=>{const r=document.querySelector('[data-tree-item="s:${destination.session.id}"] [data-test-class~="tree-row"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    const points = { from, to };
    const rows = () => app.page.expression("[...document.querySelectorAll('[data-tree-item]')].map(n=>[n.dataset.treeItem,n.offsetTop])");
    const before = await rows();
    await app.page.dragPointer(to.x, to.y);
    await waitBrowser(() => app.page.expression("Boolean(document.querySelector('[data-drop=outside]'))"), "outside row drop feedback");
    assert.deepEqual(await rows(), before, "conversation rows never reorder during a tab drag");
    const name = `${language}-${theme}-${width}-sidebar-drop`; await app.shot(name, true);
    writeFileSync(join(evidence, `${name}-gesture.json`), JSON.stringify(await app.page.expression("({outside:Boolean(document.querySelector('[data-drop=outside]'))})")));
    await app.page.pointerUp(points.to.x, points.to.y);
    writeFileSync(join(evidence, `${name}-release.json`), JSON.stringify({ trace: await app.page.expression("window.browserDropTrace"), gesture: await app.page.expression("({outside:Boolean(document.querySelector('[data-drop=outside]')),hit:document.elementFromPoint(100,500)?.outerHTML.slice(0,500)})"), state: await app.call("state"), points }));
    await waitBrowser(() => app.main(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab)}).owner === ${JSON.stringify(`conversation:${destination.session.id}`)}`), "drop moves ownership");
    results.push(name);
  }
  writeFileSync(join(evidence, "result.json"), JSON.stringify({ ok: true, results }));
} catch (error) {
  writeFileSync(join(evidence, "failure.json"), JSON.stringify({ error: String(error), state: await app.call("state"), dom: await app.page.expression("document.body.innerText") })); throw error;
} finally { await app.stop(); }
