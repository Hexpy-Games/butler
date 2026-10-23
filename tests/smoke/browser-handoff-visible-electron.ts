// test-category: race
/** A tab Butler hands over shows in the conversation's browser and takes the user's input.
 * Real App, stub model: Butler opens and reads a page, then waits for the user; "Open to check"
 * opens the conversation's browser on that tab. Main may hear the pane's slot before the tab is
 * activated, or see it covered for a moment; neither may leave the handed-over page detached. */
import { strict as assert } from "node:assert";
import { getAppCopy } from "../../packages/butler-i18n/src/index.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redesignApp } from "../support/browser-redesign-app";
import { bridgeBrowser, describeBrowser, latestBrowser } from "../support/browser-agent-stub";
import { waitBrowser } from "../support/browser-agent-app";
import { nativeAligned } from "../support/browser-shell-acceptance";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence); mkdirSync(evidence, { recursive: true });
const app = await redesignApp(evidence);
let tab = "";
const subject = () => `globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab)})`;
/** The page shows in the App window exactly where the pane last reported its slot. */
const shown = () => `(()=>{const t=${subject()},w=${app.win},v=t.view.getBounds(),s=globalThis.slotReports.get(t.id);
  return t.attached===w && Boolean(s?.visible) && ['x','y','width','height'].every(k=>v[k]===Math.round(s[k]))})()`;
try {
  await app.settings("en", "light", 1440);
  // The user's own tab is the active one while Butler works in the conversation.
  const mine = await app.call<string>("create", { url: app.url });
  // What the pane reports for each tab's slot.
  await app.main(`(()=>{const b=globalThis.browserAgentSubject,command=b.commandTab.bind(b);globalThis.slotReports=new Map();
    b.commandTab=(op,id,value,...rest)=>{if(op==='bounds')globalThis.slotReports.set(id,value);return command(op,id,value,...rest)}})()`);
  app.stub.set([describeBrowser, () => bridgeBrowser("browser_open", { url: app.url }),
    (request) => bridgeBrowser("browser_observe", { tab: latestBrowser(request, "tab").tab }),
    (request) => bridgeBrowser("browser_wait_for_user", { tab: latestBrowser(request, "tab").tab, reason: "sign_in" })]);
  await app.send("Open the fixture and let me sign in");
  await waitBrowser(async () => (await app.call<{ tabs: Array<{ id: string; agent: boolean; waiting: boolean }> }>("state")).tabs.some(item => item.agent && item.waiting), "Butler waits for the user");
  tab = (await app.call<{ tabs: Array<{ id: string; agent: boolean }> }>("state")).tabs.find(item => item.agent)!.id;
  assert.equal(await app.main("globalThis.browserAgentSubject.activeId"), mine);

  await app.click(getAppCopy("en-US").space.general);
  await waitBrowser(() => app.page.expression("Boolean(document.querySelector('[data-test-class=composer-browser-handoff]'))"), "hand-off card");
  await app.click("Open to check");
  await nativeAligned(app);
  assert.equal(await app.main("globalThis.browserAgentSubject.activeId"), tab, "the handed-over tab is the one shown");
  assert.equal(await app.main(`${subject()}.holder`), "user");
  assert.equal(await app.main(shown()), true, "the handed-over page is attached at the slot");

  // The page takes the user's click while Butler waits.
  const point = await app.main<{ x: number; y: number }>(`${subject()}.view.webContents.executeJavaScript("(()=>{const r=document.getElementById('confirm').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()")`);
  const scale = await app.main<number>(`${subject()}.bounds.scale ?? 1`);
  await app.main(`(()=>{const c=${subject()}.view.webContents,p={x:${Math.round(point.x * scale)},y:${Math.round(point.y * scale)},button:'left',clickCount:1};c.sendInputEvent({type:'mouseDown',...p});c.sendInputEvent({type:'mouseUp',...p})})()`);
  await waitBrowser(() => app.main(`${subject()}.view.webContents.executeJavaScript("document.getElementById('result').textContent==='Confirmed'")`), "the user's click reaches the page");
  assert.equal(await app.main(`${subject()}.holder`), "user");

  // The "needs you" toast stays until closed and can lie over the pane; the user closes it.
  if (await app.page.expression("Boolean(document.querySelector('[data-sonner-toast] [data-close-button]'))")) await app.page.clickSelector("[data-sonner-toast] [data-close-button]");
  await waitBrowser(async () => await app.page.expression<boolean>("!document.querySelector('[data-sonner-toast]')") && await app.main<boolean>(`!${subject()}.covered`), "toast closed, page uncovered");
  // The pane's slot reaches main before the tab is activated: the page still shows once it is.
  const early = await app.main<{ shownAfter: boolean }>(`(()=>{const b=globalThis.browserAgentSubject,t=${subject()},slot={...globalThis.slotReports.get(t.id)};
    b.activate(${JSON.stringify(mine)}); b.commandTab('bounds',t.id,slot); b.activate(t.id);
    return {shownAfter:${shown()}}})()`);
  assert.deepEqual(early, { shownAfter: true }, "a slot reported before activation places the page");
  // A moment of cover (a menu over the pane) hides the page; uncovering shows it again.
  const cover = await app.main<{ hidden: boolean; shownAfter: boolean }>(`(()=>{const b=globalThis.browserAgentSubject,t=${subject()};
    b.commandTab('covered',t.id,true); const hidden=t.attached!==${app.win};
    b.commandTab('covered',t.id,false); return {hidden,shownAfter:${shown()}}})()`);
  assert.deepEqual(cover, { hidden: true, shownAfter: true }, "uncovering shows the page again");
  await nativeAligned(app);
  writeFileSync(join(evidence, "result.json"), JSON.stringify({ ok: true, tab, early, cover }, null, 2));
} catch (error) {
  writeFileSync(join(evidence, "failure.json"), JSON.stringify({ error: String(error),
    tab: await app.main(`(()=>{const t=${subject()};return t&&{holder:t.holder,waiting:t.waiting,slot:globalThis.slotReports?.get(t.id),bounds:t.bounds,view:t.view?.getBounds(),attached:t.attached===${app.win}}})()`).catch(() => null),
    state: await app.call("state").catch(() => null), dom: await app.page.expression("document.body.innerText").catch(() => null) }, null, 2));
  await app.shot("failure").catch(() => {}); throw error;
} finally { await app.stop(); }
