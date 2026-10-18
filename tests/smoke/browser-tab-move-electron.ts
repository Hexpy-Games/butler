/** S2 actual cross-conversation pointer drop and new-conversation handover. */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redesignApp } from "../support/browser-redesign-app";
import { waitBrowser } from "../support/browser-agent-app";
import { nativeAligned } from "../support/browser-shell-acceptance";
const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence); mkdirSync(evidence, { recursive: true });
const app = await redesignApp(evidence);
try {
  const destination = await app.gateway.api<{ session: { id: string } }>("/sessions", { method: "POST", body: JSON.stringify({ kind: "chat", title: "Destination" }) });
  await app.call("open");
  const tab = await app.call<string>("create", { owner: "conversation:general", profile: "signed_out", url: app.url });
  // The lifted tab follows the pointer outside the strip only, and flags a spot that cannot take it.
  const preview = () => app.page.expression<{ title: string; invalid: boolean; width: number } | null>(`(()=>{
    const p=document.querySelector('[data-slot=drag-preview-floating] [data-slot=drag-preview][data-kind=tab]');
    return p?{title:p.textContent,invalid:Boolean(p.querySelector('[data-invalid=true]')),width:p.getBoundingClientRect().width}:null})()`);
  const settle = () => app.page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  const shot = async (name: string) => { await settle(); writeFileSync(join(evidence, `${name}.png`), await app.page.screenshot()); return preview(); };
  const rowCenter = `(()=>{const r=document.querySelector('[data-tree-item="s:${destination.session.id}"] [data-test-class~="tree-row"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`;
  for (const theme of ["light", "dark"]) {
    await app.call("move", { tabId: tab, toGroupId: "conversation:general", index: 0 });
    await app.settings("en", theme, 1440); await app.click("Browser");
    await app.page.clickSelector('[data-slot="titlebar-leading"] button');
    await waitBrowser(() => app.page.expression("Boolean(document.querySelector('[data-slot=browser-pane]'))"), "pane ready"); await nativeAligned(app);
    const title = (await app.call<{ tabs: Array<{ id: string; title: string }> }>("state")).tabs.find((item) => item.id === tab)?.title;
    assert.ok(title, "dragged tab has a title");
    const from = await app.page.expression<{ x: number; y: number }>("(()=>{const r=document.querySelector('[data-slot=tab-strip] [role=tab]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
    await waitBrowser(() => app.page.expression(`(()=>{const p=${rowCenter};return document.querySelector('[data-tree-item="s:${destination.session.id}"]').contains(document.elementFromPoint(p.x,p.y))})()`), "visible destination row");
    const to = await app.page.expression<{ x: number; y: number }>(rowCenter);
    const blank = await app.page.expression<{ x: number; y: number } | null>(`(()=>{const s=document.querySelector('[data-test-class="sidebar-scroll"]').getBoundingClientRect(),x=s.x+s.width/2;
      for(let y=s.bottom-6;y>s.top;y-=8){const h=document.elementFromPoint(x,y);if(h&&!h.closest('[data-slot=nav-drop-target]')&&!h.closest('[data-test-class="composer-card"]'))return {x,y}}return null})()`);
    assert.ok(blank, "sidebar has a spot that is not a conversation row");
    await app.page.pointerDown(from.x, from.y); await app.page.dragPointer(from.x + 10, from.y);
    await settle(); const inStrip = await preview();
    await app.page.dragPointer(to.x, to.y);
    await waitBrowser(() => app.page.expression("Boolean(document.querySelector('[data-drop=outside]'))"), "outside row drop feedback");
    const overRow = await shot(`${theme}-over-row`);
    await app.page.dragPointer(blank.x, blank.y); const overBlank = await shot(`${theme}-over-blank`);
    await app.page.dragPointer(to.x, to.y); await settle(); await app.page.pointerUp(to.x, to.y);
    await waitBrowser(() => app.main(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab)}).owner === ${JSON.stringify(`conversation:${destination.session.id}`)}`), "tab stays with drop destination");
    await settle(); const released = await preview();
    writeFileSync(join(evidence, `${theme}-preview.json`), JSON.stringify({ inStrip, overRow, overBlank, released, points: { from, to, blank } }));
    assert.equal(inStrip, null, "the strip itself shows the reorder; no lifted tab inside it");
    assert.ok(overRow && overRow.width > 0 && overRow.title === title && !overRow.invalid, "lifted tab follows the pointer over the conversation row");
    assert.ok(overBlank?.invalid, "lifted tab shows the invalid badge where no conversation takes it");
    assert.equal(released, null, "lifted tab is gone after release");
  }
  await app.internal("tabs.list", undefined, {}, destination.session.id);
  assert.equal((await app.internal("tab.observe", tab)).reason, "not_your_tab");
  assert.equal((await app.internal("tab.observe", tab, {}, destination.session.id)).status, "ok");
  await app.click("Browser"); await app.call("move", { tabId: tab, toGroupId: "mine", index: 0 }); await app.call("activate", { id: tab });
  await app.page.clickSelector('[data-slot="titlebar-leading"] button'); await app.page.clickText("New chat", '[role="menuitem"]');
  await waitBrowser(() => app.page.expression("Boolean(document.querySelector('[data-slot=adaptive-shell-split-chat]'))"), "new conversation docked");
  writeFileSync(join(evidence, "result.json"), JSON.stringify({ ok: true, state: await app.call("state") }));
} catch (error) {
  writeFileSync(join(evidence, "failure.json"), JSON.stringify({ error: String(error), state: await app.call("state"), dom: await app.page.expression("document.body.innerText") })); throw error;
} finally { await app.stop(); }
