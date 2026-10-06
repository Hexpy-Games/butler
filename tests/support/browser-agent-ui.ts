import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { waitBrowser, type browserAgentApp } from "./browser-agent-app";

type App=Awaited<ReturnType<typeof browserAgentApp>>;
/** Trusted UI input covers artifact entry, group focus and DS drag handover. */
export async function browserOutputEntry(app:App,evidence:string) {
  await app.gateway.api("/settings",{method:"PATCH",body:JSON.stringify({language:"en",appearance_theme:"light"})});
  await app.page.reload();
  await app.page.waitForFunction(()=>Boolean(document.querySelector('[data-test-class="app-sidebar"]')));
  await app.page.waitForFunction(()=>document.documentElement.lang==='en-US' && Array.from(document.querySelectorAll('[data-test-class="app-sidebar"] *')).some(node=>node.textContent?.trim()==='General'));
  await app.page.clickText("General",'[data-test-class="app-sidebar"] *');
  await app.page.waitForFunction(()=>Boolean(document.querySelector('[data-test-class="message-artifact-list"] [aria-label="Browser task"]')));
  await app.page.clickText("Browser task",'[data-test-class="message-artifact-list"] *');
  await app.page.waitForFunction(()=>Boolean(document.querySelector('[data-test-class="artifact-viewer"] iframe')));
  await app.click("Open in Browser");
  await app.page.waitForFunction(()=>Boolean(document.querySelector('[data-test-class="browser-area"]')));
  const state=await app.call<{activeId:string;tabs:Array<{id:string;owner:string;agent:boolean}>}>("state");
  const opened=state.tabs.find(tab=>tab.id===state.activeId)!;
  assert.equal(opened.owner,"conversation:general");assert.equal(opened.agent,false);
  assert.equal(await app.page.expression("Boolean(document.querySelector('button[aria-label=\"Hide right panel\"]'))"),true,"artifact entry docks its conversation");
  await app.call("close",{id:opened.id});
  writeFileSync(join(evidence,"public-artifact-entry.json"),JSON.stringify({opened,rightChat:true},null,2));
}

export async function browserUiChecks(app:App,agentTab:string,evidence:string) {
  const url=await app.main<string>(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(agentTab)}).url`);
  const anchor=await app.call<string>("create",{owner:"conversation:general",url,profile:"signed_out"});
  const opened={id:anchor};
  const webgl=await app.main(`(async()=>{const tabs=globalThis.browserAgentSubject.tabs;const test=async id=>tabs.get(id).view.webContents.executeJavaScript("(()=>{const gl=document.createElement('canvas').getContext('webgl');const enabled=Boolean(gl);gl?.getExtension('WEBGL_lose_context')?.loseContext();return enabled})()");return {user:await test(${JSON.stringify(opened.id)}),agent:await test(${JSON.stringify(agentTab)})}})()`);
  assert.deepEqual(webgl,{user:true,agent:false},"WebGL is disabled only for agent-opened tabs");
  await app.call("activate",{id:agentTab});
  await app.click("Browser");
  await app.page.evaluate(()=>new Promise<void>(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done()))));
  await dragTo(app,'mine',evidence);
  await waitBrowser(async()=>(await app.call<{tabs:Array<{id:string;owner:string}>}>("state")).tabs.find(tab=>tab.id===agentTab)?.owner==='mine',"DS drag to my tabs");
  await dragTo(app,'conversation',evidence);
  await waitBrowser(async()=>(await app.call<{tabs:Array<{id:string;owner:string}>}>("state")).tabs.find(tab=>tab.id===agentTab)?.owner==='conversation:general',"DS drag back to conversation");
  const handover=await app.call<{tabs:Array<{id:string;owner:string;holder:string}>}>("state");
  assert.equal(handover.tabs.find(tab=>tab.id===agentTab)?.holder,'agent');
  await app.call("control",{id:agentTab,holder:"agent"});
  await app.call("close",{id:opened.id});
  writeFileSync(join(evidence,"public-ui-entry-drag.json"),JSON.stringify({opened,handover},null,2));
}

async function dragTo(app:App,kind:string,evidence:string) {
  const points=await app.page.expression<{from:{x:number;y:number};to:{x:number;y:number}}>(`(()=>{
    const source=document.querySelector('[data-test-class="browser-area"] [role="tab"][aria-selected="true"]');
    const target=document.querySelector('[data-test-class="tab-strip-chip"] [data-kind="${kind}"]');
    if(!source || !target)throw new Error('drag target missing');
    const point=node=>{const r=node.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}};
    const from=point(source),to=point(target);return {from,to,source:source.outerHTML,target:target.outerHTML,sourceHit:document.elementFromPoint(from.x,from.y)?.outerHTML};
  })()`);
  writeFileSync(join(evidence,`drag-${kind}-points.json`),JSON.stringify(points,null,2));
  await waitBrowser(()=>app.page.expression(`(()=>{const p=${JSON.stringify(points.from)},source=document.querySelector('[data-test-class="browser-area"] [role="tab"][aria-selected="true"]');return source?.contains(document.elementFromPoint(p.x,p.y))})()`),"tab drag source is hit-testable");
  await app.page.drag(points.from,points.to);
  const after=await app.page.expression(`({dragging:document.querySelector('[data-dragging="true"]')?.outerHTML,text:document.querySelector('[data-test-class="browser-area"]')?.innerText})`);
  writeFileSync(join(evidence,`drag-${kind}-after.json`),JSON.stringify(after));
}

/** Real App presentation of the native crashed-state snapshot, including folded groups. */
export async function browserGroupSnapshotChecks(app:App,tab:string,language:string,theme:string,evidence:string) {
  await app.main(`(()=>{const b=globalThis.browserAgentSubject,t=b.tabs.get(${JSON.stringify(tab)});t.status='crashed';b.sync(t);b.publish()})()`);
  const selector='[data-test-class="tab-strip-chip"] [data-kind="conversation"][data-state="crashed"]';
  try {
    await app.page.waitForFunction(()=>Boolean(document.querySelector('[data-test-class="tab-strip-chip"] [data-kind="conversation"][data-state="crashed"]')));
    const label=await app.page.expression<string>(`document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-label')`);
    assert.ok(label.includes(language==='ko'?'탭 1개':'Tabs: 1'));
    assert.ok(label.includes(language==='ko'?'탭이 중단됨':'Tab crashed'));
    await app.click(label);
    assert.equal(await app.page.expression(`document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-expanded')`),'false');
    await app.shot(`${language}-${theme}-folded-crashed-snapshot-1440`);
    const foldedLabel=await app.page.expression<string>(`document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-label')`);
    assert.ok(foldedLabel.includes(language==='ko'?'탭이 중단됨':'Tab crashed'));
    await app.page.clickText(foldedLabel,selector);
    assert.equal(await app.page.expression(`document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-expanded')`),'true');
    writeFileSync(join(evidence,`${language}-${theme}-group-snapshot.json`),JSON.stringify({label,foldedState:'crashed',scenario:'native snapshot projection',rendererKilled:false}));
  } catch(error) {
    writeFileSync(join(evidence,`${language}-${theme}-group-failure.json`),JSON.stringify(await app.page.expression(`({buttons:[...document.querySelectorAll('button,[role="button"]')].map(node=>({label:node.getAttribute('aria-label'),disabled:node.getAttribute('aria-disabled'),width:node.getBoundingClientRect().width,animations:node.getAnimations().map(a=>a.playState)})),html:document.querySelector('[data-test-class="browser-area"]')?.outerHTML})`)));
    throw error;
  } finally {await app.main(`(()=>{const b=globalThis.browserAgentSubject,t=b.tabs.get(${JSON.stringify(tab)});t.status='idle';b.sync(t);b.publish()})()`);}
}
