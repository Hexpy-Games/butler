import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { waitBrowser, type browserAgentApp } from "./browser-agent-app";

type App=Awaited<ReturnType<typeof browserAgentApp>>;
/** Native frame identity and mid-batch drag exercise the production executor. */
export async function browserBoundaryChecks(app: App, tab: string, evidence: string) {
  await checkDeniedReceipts(app,tab,evidence);
  await checkStillFailureReceipts(app,tab,evidence);
  await checkRefScrolling(app,tab,evidence);
  const subject="globalThis.browserAgentSubject", id=JSON.stringify(tab);
  const frames=await app.main(`(async()=>{const t=${subject}.tabs.get(${id});await t.view.webContents.executeJavaScript("Promise.all([0,1].map(n=>new Promise(done=>{const f=document.createElement('iframe');f.id='browser-frame-'+n;f.srcdoc='<button>Confirm</button>';f.onload=done;document.body.append(f)})))");const tree=await t.view.webContents.debugger.sendCommand('Page.getFrameTree');return {electron:t.view.webContents.mainFrame.framesInSubtree.map(f=>({token:f.frameToken,url:f.url})),tree}})()`);
  writeFileSync(join(evidence,"frame-identity.json"),JSON.stringify(frames,null,2));
  const observed=await app.main<any>(`${subject}.execute({op:'tab.observe',session:'general',tab:${id},args:{}})`);
  assert.equal(observed.status,"ok");
  const selected=await app.main<any>(`${subject}.execute({op:'tab.observe',session:'general',tab:${id},args:{frame:'f1'}})`);
  assert.equal(selected.status,"ok");assert.equal(selected.frames.length,1);assert.equal(selected.frames[0].id,'f1');
  assert.equal(selected.nodes.filter((node:any)=>node.name==='Confirm').length,1);
  assert.ok(selected.nodes.every((node:any)=>node.ref.startsWith('f1-')));
  const missing=await app.main<any>(`${subject}.execute({op:'tab.observe',session:'general',tab:${id},args:{frame:'f999'}})`);
  assert.deepEqual(missing,{status:'refused',reason:'frame_unavailable'});
  writeFileSync(join(evidence,'frame-scoped-observation.json'),JSON.stringify({selected,missing},null,2));
  assert.equal(observed.nodes.filter((node:any)=>node.name==="Confirm").length,3,"duplicate-URL frames have distinct isolated observations");
  await app.main(`${subject}.tabs.get(${id}).view.webContents.executeJavaScript("document.querySelectorAll('iframe[id^=browser-frame]').forEach(f=>f.remove())")`);
  await app.main(`${subject}.tabs.get(${id}).view.webContents.executeJavaScript("(()=>{const host=document.createElement('div');host.id='closed-fixture';document.body.append(host);host.attachShadow({mode:'closed'}).innerHTML='<button>Closed action</button>'})()")`);
  const closed=await app.main<any>(`${subject}.execute({op:'tab.observe',session:'general',tab:${id},args:{}})`);
  assert.ok(closed.nodes.some((node:any)=>node.name==='Closed action'));
  await app.main(`${subject}.tabs.get(${id}).view.webContents.executeJavaScript("document.getElementById('closed-fixture').remove()")`);
  const removed=await app.main<any>(`${subject}.execute({op:'tab.observe',session:'general',tab:${id},args:{}})`);
  assert.ok(!removed.nodes.some((node:any)=>node.name==='Closed action'),"removed closed roots never survive the newest observation");
  await app.main(`${subject}.tabs.get(${id}).view.webContents.executeJavaScript("document.body.insertAdjacentHTML('beforeend','<button id=disabled-fixture aria-disabled=true>Disabled action</button>')")`);
  const disabled=await app.main<any>(`(async()=>{const b=${subject},o=await b.execute({op:'tab.observe',session:'general',tab:${id},args:{}});const node=o.nodes.find(n=>n.name==='Disabled action');return {node,receipt:await b.execute({op:'tab.prepare',session:'general',tab:${id},args:{observation:o.obs,steps:[{action:'click',ref:node.ref}]}})}})()`);
  assert.equal(disabled.node.actionable,false);assert.equal(disabled.receipt.reason,'not_actionable');
  writeFileSync(join(evidence,'aria-disabled-ref.json'),JSON.stringify(disabled,null,2));
  await app.main(`${subject}.tabs.get(${id}).view.webContents.executeJavaScript("document.getElementById('disabled-fixture').remove()")`);
  const keypadMarkup='<div id="keypad-fixture" class="nxkey" style="position:fixed;top:10px;left:700px;z-index:100"><button>Key seven</button></div>';
  await app.main(`${subject}.tabs.get(${id}).view.webContents.executeJavaScript(${JSON.stringify(`document.body.insertAdjacentHTML('beforeend',${JSON.stringify(keypadMarkup)})`)})`);
  const keypad=await app.main<any>(`(async()=>{const b=${subject},o=await b.execute({op:'tab.observe',session:'general',tab:${id},args:{}});const node=o.nodes.find(n=>n.name==='Key seven');return {node,receipt:await b.execute({op:'tab.prepare',session:'general',tab:${id},args:{observation:o.obs,steps:[{action:'click',ref:node.ref}]}})}})()`);
  assert.equal(keypad.node.secure,true);assert.equal(keypad.node.actionable,false);assert.equal(keypad.receipt.reason,'secure_field');
  writeFileSync(join(evidence,'secure-keypad-descendant.json'),JSON.stringify(keypad,null,2));
  await app.main(`${subject}.tabs.get(${id}).view.webContents.executeJavaScript("document.getElementById('keypad-fixture').remove()")`);
  const addons=await app.main<any>(`(async()=>{const b=${subject},t=b.tabs.get(${id}),wc=t.view.webContents;await wc.executeJavaScript("document.body.insertAdjacentHTML('beforeend','<label id=addon-fixture><input type=checkbox id=addon-check>Bonus gift</label>')");const o=await b.execute({op:'tab.observe',session:'general',tab:t.id,args:{}}),ref=o.nodes.find(n=>n.name==='Confirm').ref;await wc.executeJavaScript("document.getElementById('addon-check').checked=true");const args={observation:o.obs,steps:[{action:'click',ref}]},p=await b.execute({op:'tab.prepare',session:'general',tab:t.id,args});await wc.executeJavaScript("document.getElementById('addon-check').checked=false");const receipt=await b.execute({op:'tab.act',session:'general',tab:t.id,args:{...args,prepared_steps:p.steps}});await wc.executeJavaScript("document.getElementById('addon-fixture').remove()");return {prepared:p,receipt}})()`);
  assert.ok(addons.prepared.steps[0].addons.includes('Bonus gift'));
  assert.equal(addons.receipt.steps[0].status,'not_dispatched');assert.equal(addons.receipt.steps[0].reason,'approval_target_changed');
  writeFileSync(join(evidence,'changed-addons-receipt.json'),JSON.stringify(addons,null,2));
  const oopif=process.env.BUTLER_BROWSER_OOPIF_URL;
  if(oopif) await checkOopif(app,tab,oopif,evidence);
  const receipt=await app.main<any>(`(async()=>{const browser=${subject},tab=browser.tabs.get(${id});const o=await browser.execute({op:'tab.observe',session:'general',tab:${id},args:{}});const ref=o.nodes.find(n=>n.name==='Confirm').ref;const args={observation:o.obs,steps:[{action:'click',ref},{action:'click',ref}]};const prepared=await browser.execute({op:'tab.prepare',session:'general',tab:${id},args});const contents=tab.view.webContents,send=contents.sendInputEvent;contents.sendInputEvent=function(input){send.call(this,input);if(input.type==='mouseUp'){this.sendInputEvent=send;browser.move({tabId:tab.id,toGroupId:'mine',index:0})}};try{return await browser.execute({op:'tab.act',session:'general',tab:${id},args:{...args,prepared_steps:prepared.steps}})}finally{contents.sendInputEvent=send;browser.move({tabId:tab.id,toGroupId:'conversation:general',index:0})}})()`);
  assert.equal(receipt.steps[0].status,"completed");
  assert.equal(receipt.steps[1].status,"not_dispatched");
  assert.equal(receipt.steps[1].reason,"owner_changed");
  writeFileSync(join(evidence,"mid-batch-handover.json"),JSON.stringify(receipt,null,2));
}

/** Explicit public fixture only; regular stub smokes have no network dependency. */
async function checkOopif(app:App,tab:string,url:string,evidence:string) {
  const id=JSON.stringify(tab),origin=new URL(url).origin;
  await app.main(`globalThis.browserAgentSubject.tabs.get(${id}).view.webContents.executeJavaScript(${JSON.stringify(`(()=>{const f=document.createElement('iframe');f.id='oopif-fixture';f.src=${JSON.stringify(url)};f.width='450';f.height='350';document.body.append(f)})()`)})`);
  await waitBrowser(()=>app.main<boolean>(`globalThis.browserAgentSubject.tabs.get(${id}).view.webContents.mainFrame.framesInSubtree.some(f=>f.url.startsWith(${JSON.stringify(origin)}))`),"cross-site iframe loaded");
  await waitBrowser(()=>app.main<boolean>(`globalThis.browserAgentSubject.tabs.get(${id}).view.webContents.mainFrame.framesInSubtree.find(f=>f.url.startsWith(${JSON.stringify(origin)})).executeJavaScript("Boolean(document.body)")`).catch(()=>false),"cross-site document ready");
  await app.main(`globalThis.browserAgentSubject.tabs.get(${id}).view.webContents.mainFrame.framesInSubtree.find(f=>f.url.startsWith(${JSON.stringify(origin)})).executeJavaScript("(()=>{const b=document.createElement(\'button\');b.textContent=\'Frame action\';b.style=\'position:fixed;left:20px;top:20px;z-index:100\';document.body.append(b)})()")`);
  const proof=await app.main<any>(`(async()=>{const b=globalThis.browserAgentSubject,t=b.tabs.get(${id}),root=t.view.webContents.mainFrame;const child=root.framesInSubtree.find(f=>f.url.startsWith(${JSON.stringify(origin)}));const o=await b.execute({op:'tab.observe',session:'general',tab:t.id,args:{}});globalThis.oopifProof={observation:o,contexts:[...t.contextNames],worlds:[...t.nativeFrames.keys()]};const target=o.nodes?.find(n=>n.frameOrigin===${JSON.stringify(origin)} && n.name==='Frame action' && n.actionable);if(!target)throw new Error('cross-site target missing');const args={observation:o.obs,steps:[{action:'hover',ref:target.ref}]};const p=await b.execute({op:'tab.prepare',session:'general',tab:t.id,args});const receipt=await b.execute({op:'tab.act',session:'general',tab:t.id,args:{...args,prepared_steps:p.steps}});globalThis.oopifProof.prepared=p;globalThis.oopifProof.receipt=receipt;const f=t.observation.bindings.get(target.ref);const api=process.getBuiltinModule('module').createRequire(process.cwd()+'/packages/butler-app/client/electron/package.json')(process.cwd()+'/packages/butler-app/client/electron/browser/frame-worlds.mjs');const local=await api.evaluateWorld(f,'(()=>{const r=globalThis.__butlerObservation.refs.get('+JSON.stringify(target.ref)+').deref().getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()');const point=await api.framePoint(f,local);globalThis.oopifProof.hit={point,frame:f.id,parent:f.parent.id,owner:await f.parent.api.sendCommand('DOM.getFrameOwner',{frameId:f.id}),location:await t.observation.main.api.sendCommand('DOM.getNodeForLocation',{x:Math.round(point.x),y:Math.round(point.y),includeUserAgentShadowDOM:true})};return {mainProcess:root.processId,childProcess:child.processId,target,prepared:p,receipt}})()`);
  writeFileSync(join(evidence,"oopif-ref.json"),JSON.stringify(proof,null,2));
  assert.notEqual(proof.mainProcess,proof.childProcess,"actual OOPIF process boundary");
  assert.equal(proof.receipt.steps[0].status,"completed","native child observation and cross-frame hit recheck");
  await app.main(`globalThis.browserAgentSubject.tabs.get(${id}).view.webContents.executeJavaScript("document.getElementById('oopif-fixture').remove()")`);
}

/** Visible refs avoid no-op scrolling; moved refs still scroll and re-hit-test. */
async function checkRefScrolling(app:App,tab:string,evidence:string) {
  const proof=await app.main<any>(`(async()=>{const b=globalThis.browserAgentSubject,t=b.tabs.get(${JSON.stringify(tab)}),wc=t.view.webContents;const world=code=>wc.executeJavaScriptInIsolatedWorld(9001,[{code}]);await world("globalThis.refScrollCount=0;globalThis.originalRefScroll=Element.prototype.scrollIntoView;Element.prototype.scrollIntoView=function(...args){refScrollCount++;return originalRefScroll.apply(this,args)};void 0");try{const o=await b.execute({op:'tab.observe',session:'general',tab:t.id,args:{}}),ref=o.nodes.find(n=>n.name==='Confirm').ref,args={observation:o.obs,steps:[{action:'click',ref}]};const p=await b.execute({op:'tab.prepare',session:'general',tab:t.id,args});const visible=await b.execute({op:'tab.act',session:'general',tab:t.id,args:{...args,prepared_steps:p.steps}}),visibleCalls=await world('refScrollCount');await wc.executeJavaScript("document.getElementById('confirm').style='position:absolute;top:1500px'");const moved=await b.execute({op:'tab.act',session:'general',tab:t.id,args:{...args,prepared_steps:p.steps}}),scrolledCalls=await world('refScrollCount');return {visible,visibleCalls,moved,scrolledCalls}}finally{await world('Element.prototype.scrollIntoView=originalRefScroll;delete globalThis.originalRefScroll');await wc.executeJavaScript("document.getElementById('confirm').style='';window.scrollTo(0,0)")}})()`);
  assert.equal(proof.visible.steps[0].status,'completed');assert.equal(proof.visibleCalls,0);
  assert.equal(proof.moved.steps[0].status,'completed');assert.ok(proof.scrolledCalls>0);
  writeFileSync(join(evidence,'ref-scroll-and-hit.json'),JSON.stringify(proof,null,2));
}

async function checkDeniedReceipts(app:App,tab:string,evidence:string) {
  const results=await app.main<any>(`(async()=>{const b=globalThis.browserAgentSubject,t=b.tabs.get(${JSON.stringify(tab)}),args={steps:[{action:'click',ref:'e1'},{action:'click',ref:'e2'}]};const wrong=await b.execute({op:'tab.act',session:'other',tab:t.id,args});const original=t.holder;try{t.holder='user';return {wrong,user:await b.execute({op:'tab.act',session:'general',tab:t.id,args}),close:await b.execute({op:'tab.close',session:'general',tab:t.id,args:{}})}}finally{t.holder=original}})()`);
  assert.equal(results.close.reason,'user_control');
  for(const [name,result] of Object.entries(results).filter(([name])=>name!=='close') as [string,any][]) {
    assert.equal(result.steps.length,2);
    for(const step of result.steps){assert.equal(step.status,'not_dispatched');assert.equal(step.reason,name==='wrong'?'not_your_tab':'user_control');}
  }
  writeFileSync(join(evidence,'native-denied-batch-receipts.json'),JSON.stringify(results,null,2));
}

async function checkStillFailureReceipts(app:App,tab:string,evidence:string) {
  const receipt=await app.main<any>(`(async()=>{const b=globalThis.browserAgentSubject,t=b.tabs.get(${JSON.stringify(tab)}),wc=t.view.webContents,o=await b.execute({op:'tab.observe',session:'general',tab:t.id,args:{}}),ref=o.nodes.find(n=>n.name==='Confirm').ref,args={observation:o.obs,steps:[{action:'hover',ref},{action:'hover',ref}]},p=await b.execute({op:'tab.prepare',session:'general',tab:t.id,args}),capture=wc.capturePage;wc.capturePage=async()=>({isEmpty:()=>false,resize:()=>{throw new Error('injected still encoder failure')}});try{return await b.execute({op:'tab.act',session:'general',tab:t.id,args:{...args,prepared_steps:p.steps}})}finally{wc.capturePage=capture}})()`);
  assert.equal(receipt.steps.length,2);assert.equal(receipt.steps[0].status,'unknown');
  assert.equal(receipt.steps[1].status,'not_dispatched');assert.equal(receipt.steps[1].reason,'previous_step_failed');
  writeFileSync(join(evidence,'still-failure-batch-receipts.json'),JSON.stringify(receipt,null,2));
}
