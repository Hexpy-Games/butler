import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ElectronPage } from "./electron-page-cdp";
import type { connectElectronMain } from "./electron-main-cdp";
import { visibleClipping } from "./visible-clipping";
import type { NativeAppServerHandle } from "./native-app-server";
import { getAppCopy } from "../../packages/butler-i18n/src";

const copy = getAppCopy("ko-KR");
type Main = Awaited<ReturnType<typeof connectElectronMain>>;
type Options = { page: ElectronPage; main: Main; win: string; evidence: string; server: NativeAppServerHandle;
  click: (page: ElectronPage, name: string, scope?: string) => Promise<void> };

export async function textSizeSweep({ page, main, win, evidence, click, server }: Options) {
  const select = async (selector: string) => {
    await page.expression(`new Promise(done=>{const check=()=>{
      const n=document.querySelector(${JSON.stringify(selector)});n?.scrollIntoView({block:'nearest'});
      if(n){const r=n.getBoundingClientRect();if(r.width&&r.height&&n.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))){done(true);return;}}
      setTimeout(check,50);
    };check()})`);
    await page.clickSelector(selector);
  };
  const findings: unknown[] = [];
  const baselines = new Map<string, ReturnType<typeof visibleClipping>>();
  const zoomOnly: unknown[] = [];
  const preExisting: unknown[] = [];
  const findingKey = (clip: ReturnType<typeof visibleClipping>[number]) => JSON.stringify([clip.selector, clip.ancestor, clip.side]);
  for (const [width, height] of [[1280, 800], [1440, 900]]) {
    for (const [size, scale] of [["default", 1], ["large", 1.15], ["larger", 1.3]] as const) {
      await page.expression(`window.butlerApp.setTextSize(${JSON.stringify(size)})`);
      await main.evaluate(`${win}.setContentSize(${width},${height})`);
      await page.waitForFunction(() => document.fonts.status === "loaded");
      await page.expression(`new Promise(done=>{const check=()=>Math.abs(innerWidth*${scale}-${width})<=1?done(true):setTimeout(check,20);check()})`);
      const audit = async (screen: string) => {
        await page.waitForFunction(() => document.getAnimations().every(animation =>
          !(animation.timeline instanceof DocumentTimeline) || animation.effect?.getTiming().iterations === Infinity || animation.playState !== "running"));
        const clips = await page.evaluate(visibleClipping);
        const window = `${width}x${height}`;
        const key = JSON.stringify([screen, window]);
        if (scale === 1) baselines.set(key, clips);
        const baseline = baselines.get(key);
        assert(baseline, `100% baseline required before ${screen}/${window}/${scale}`);
        const baselineKeys = new Set(baseline.map(findingKey));
        const classified = clips.map(clip => ({ screen, scale, window, ...clip,
          status: scale === 1 || baselineKeys.has(findingKey(clip)) ? "pre-existing" : "zoom-only" }));
        preExisting.push(...classified.filter(clip => clip.status === "pre-existing"));
        zoomOnly.push(...classified.filter(clip => clip.status === "zoom-only"));
        const row = { screen, scale, window, findings: classified };
        console.log(JSON.stringify(row)); findings.push(row);
        writeFileSync(join(evidence, "visible-clipping.json"), JSON.stringify(findings, null, 2));
        writeFileSync(join(evidence, `${screen}-${width}-${scale}.png`), await page.screenshot());
      };
      const before = new Set((await server.api<{ sessions:Array<{ id:string }> }>("/sessions")).sessions.map(row=>row.id));
      await click(page, copy.sidebar.newChat);
      await page.waitForFunction(() => Boolean(document.querySelector('[data-test-class="new-chat-empty-state"]')));
      await audit("new-chat");
      await click(page, copy.space.recent, '[role="radio"]');
      await page.waitForFunction(() => document.querySelectorAll('[data-test-class="app-sidebar"] [data-tree-item]').length >= 30);
      await audit("sidebar-30-sessions");
      await select('[data-test-class="app-sidebar"] [data-slot="dropdown-menu-trigger"]');
      await page.waitForFunction(() => Boolean(document.querySelector('[role="menu"]')));
      await audit("session-menu"); await page.press("Escape");
      await click(page, copy.space.all, '[role="radio"]');
      await select('[data-slot="composer-compact-preview"]');
      await page.waitForFunction(() => document.activeElement?.getAttribute("contenteditable") === "true");
      await page.insertText("긴 답변을 보여 주세요.");
      await select('[data-test-class="composer-send-button"]');
      await page.waitForFunction(() => document.body.textContent?.includes("30번째 문단: 읽기 쉬운 긴 답변입니다."));
      // Persisted panel visibility must not make later scales a different screen.
      if (!await page.expression("document.querySelector('[data-test-class=\"session-info-toggle\"]')?.getAttribute('aria-pressed')==='true'"))
        await select('[data-test-class="session-info-toggle"]');
      await page.waitForFunction(() => Boolean(document.querySelector('[data-slot="disclosure-row-title"]')));
      await audit("long-chat");
      if (await page.expression("Boolean(document.querySelector('[data-slot=\"composer-compact-preview\"]'))")) await select('[data-slot="composer-compact-preview"]');
      await select('[data-test-class="model-button"]');
      await page.waitForFunction(() => Boolean(document.querySelector('[data-slot="popover-content"]')));
      await audit("composer-popover"); await page.press("Escape");
      await page.waitForFunction(() => !document.querySelector('[data-slot="popover-content"]'));
      const created = (await server.api<{ sessions:Array<{ id:string }> }>("/sessions")).sessions.filter(row=>!before.has(row.id));
      assert.equal(created.length, 1, "Sending the draft creates exactly one session");
      const sessionId = created[0].id;
      const view = await server.api<{ messages:Array<{ id:string;role:string }> }>(`/session-view?session_id=${sessionId}`);
      const message = view.messages.find(m=>m.role==="assistant"); assert(message, "long answer stored");
      await server.api("/documents", { method:"POST", body:JSON.stringify({ title:"읽기 검증 문서", body:"# 읽기 검증\n\n모든 문장을 표시합니다.\n\n".repeat(20), author:"butler", chat_id:sessionId, message_id:message.id }) });
      // Reopen the session after API publication, as a user opening a result
      // does: switching sessions loads its complete native session view.
      const navigation = await server.api<{ space:{ nodes:Array<{ key:string;entityId:string }> } }>("/navigation");
      const node = navigation.space.nodes.find(row=>row.entityId===sessionId); assert(node, "new session in navigation");
      await click(page, copy.sidebar.newChat);
      await select(`[data-tree-item=${JSON.stringify(node.key)}] [role="button"]`);
      if (!await page.expression("document.querySelector('[data-test-class=\"session-info-toggle\"]')?.getAttribute('aria-pressed')==='true'"))
        await select('[data-test-class="session-info-toggle"]');
      await page.waitForFunction(() => [...document.querySelectorAll('[data-slot="document-tile"]')].some(n=>n.textContent?.includes("읽기 검증 문서")));
      await select('[data-slot="document-tile"]');
      await page.waitForFunction(() => Boolean(document.querySelector('[data-test-class="file-viewer"]')));
      await audit("document-viewer");
      await select('[data-test-class="file-viewer-close"]');
      await click(page, copy.sidebar.search);
      await page.waitForFunction(() => Boolean(document.querySelector('[role="dialog"]')));
      await audit("dialog"); await page.press("Escape");
      await click(page, copy.sidebar.settings);
      const labels = await page.expression<string[]>("[...document.querySelectorAll('[data-test-class=\"settings-navigation-scroll\"] nav [role=\"button\"]')].map(n=>(n.getAttribute('aria-label')||n.textContent).trim())");
      assert(labels.length >= 15, `All settings sections required: ${JSON.stringify(labels)}`);
      for (const label of labels) {
        await click(page, label, '[data-test-class="settings-navigation-scroll"] nav [role="button"]');
        await page.expression(`new Promise(done=>{const check=()=>document.querySelector('[data-test-class="settings-detail-title"]')?.textContent?.trim()===${JSON.stringify(label)}?done(true):setTimeout(check,20);check()})`);
        for (const [position, fraction] of [["top", 0], ["middle", 0.5], ["bottom", 1]] as const) {
          await page.expression(`(()=>{const root=document.querySelector('[data-test-class="settings-detail-scroll"]');
            for(const n of [root,...root.querySelectorAll('*')])if(['auto','scroll'].includes(getComputedStyle(n).overflowY)&&n.scrollHeight>n.clientHeight)n.scrollTop=(n.scrollHeight-n.clientHeight)*${fraction};})()`);
          await audit(`settings-${label}-${position}`);
        }
      }
      await click(page, copy.settings.back);
      await click(page, copy.browser.title);
      await page.waitForFunction(() => Boolean(document.querySelector('[data-test-class="browser-area"]')));
      await audit("browser-chrome");
      await click(page, copy.sidebar.newChat);
      const tooltipTrigger = '[data-test-class="chrome-floating-toggle-layer"] button';
      const point = await page.expression<{ x:number;y:number }>(`(()=>{const n=document.querySelector(${JSON.stringify(tooltipTrigger)}),r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await page.movePointer(point.x, point.y);
      await page.expression(`new Promise(done=>{const check=()=>{
        const trigger=document.querySelector(${JSON.stringify(tooltipTrigger)}),id=trigger?.getAttribute('aria-describedby');
        const n=id&&document.getElementById(id);
        if(n?.getAttribute('role')==='tooltip'&&n.getAttribute('data-state')==='open'&&n.checkVisibility({visibilityProperty:true,opacityProperty:true})){done(true);return;}
        setTimeout(check,50);
      };check()})`);
      await audit("tooltip");
    }
  }
  writeFileSync(join(evidence, "visible-clipping.json"), JSON.stringify(findings, null, 2));
  console.log(JSON.stringify({ preExisting, zoomOnly }));
  assert.deepEqual(zoomOnly, [], `Text size introduced clipping: ${JSON.stringify(zoomOnly)}`);
  return findings;
}
