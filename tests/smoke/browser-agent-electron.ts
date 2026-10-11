/** P2a-2 public guided tools, ownership, authority and native hand-back in the real App. */
import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join, resolve } from "node:path";
import { nativeAligned } from "../support/browser-shell-acceptance";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app";
import { browserStub, describeBrowser, bridgeBrowser, latestBrowser, actConfirm } from "../support/browser-agent-stub";
import { launchSmokeBrowser } from "../support/smoke-browser";
import { soakBrowser } from "../support/browser-agent-soak";
import { browserBoundaryChecks } from "../support/browser-agent-boundaries";
import { browserAuthorityChecks } from "../support/browser-agent-authority";
import { browserArchiveCheck } from "../support/browser-agent-lifecycle";
import { browserUiChecks, browserOutputEntry, browserGroupSnapshotChecks } from "../support/browser-agent-ui";
import { browserContextCheck, browserProviderByteCheck } from "../support/browser-agent-context";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence);
mkdirSync(evidence, { recursive: true });
const stub = browserStub();
const baseline = process.env.BUTLER_BROWSER_BASELINE === "1";
const app = await browserAgentApp(evidence, stub.handler, baseline ? resolve(evidence, "../baseline-dist") : undefined);
type Tab = { id: string; owner: string; holder: string; profile: string; epoch: number; waiting: boolean; agent: boolean };
const state = () => app.call<{ tabs: Tab[]; activeId: string }>("state");
const traces: unknown[] = [];
async function send(text: string) {
  const prior = await app.gateway.api<{ latest_turn?: { id: string } }>("/session-view?session_id=general");
  await app.gateway.api("/messages", { method: "POST", body: JSON.stringify({ chat_id: "general", text, client_message_id: crypto.randomUUID() }) });
  await waitBrowser(async()=>(await app.gateway.api<{ latest_turn?: { id: string } }>("/session-view?session_id=general")).latest_turn?.id !== prior.latest_turn?.id, "new guided turn");
}
const delivered = () => waitBrowser(async () => (await app.gateway.api<{ latest_turn?: { state: string } }>("/session-view?session_id=general")).latest_turn?.state === "delivered", "delivered guided turn");
async function internal(op: string, tab?: string, args = {}, session = "general") {
  const admin = JSON.parse(await Bun.file(join(app.gateway.butlerData, "app/runtime/auth/local-admin.json")).text()).secret as string;
  const response = await fetch(`${app.gateway.url}/internal/browser/calls`, { method: "POST", headers: { ...app.gateway.authHeaders, "x-butler-admin": admin, "content-type": "application/json" }, body: JSON.stringify({ op, session, tab, args }) });
  const result = await response.json(); traces.push({ op, session, status: response.status, result }); return result;
}
async function settings(language: string, theme: string) {
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language, appearance_theme: theme }) });
  await app.page.reload();
  await app.page.waitForFunction(()=>Boolean(document.querySelector('[data-test-class="app-sidebar"]')));
  await app.click(language === "ko" ? "브라우저" : "Browser");
  await app.page.waitForFunction(()=>Boolean(document.querySelector('[data-test-class="browser-area"]')));
  await nativeAligned(app);
  await app.call("activate", { id: agentTab.id });
  await waitBrowser(()=>app.page.expression(`document.querySelector('[data-slot="titlebar-leading"] button')?.textContent.trim() === ${JSON.stringify(language === "ko" ? "일반" : "General")}`), "owned hub conversation button");
  await app.page.clickSelector('[data-slot="titlebar-leading"] button');
  await nativeAligned(app);
  try { await app.page.waitForFunction(()=>Boolean(document.querySelector('[data-test-class="message assistant"]'))); }
  catch(error) {writeFileSync(join(evidence!,`${language}-${theme}-ui-failure.json`),JSON.stringify(await app.page.expression("({text:document.body.innerText,classes:[...document.querySelectorAll('[data-test-class]')].map(e=>e.getAttribute('data-test-class'))})")));await app.shot(`${language}-${theme}-ui-failure`);throw error;}
}
let agentTab!: Tab;
try {
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language: "en", appearance_theme: "light", access_mode: "full_access" }) });
  await app.call("open");
  stub.set([
    () => ({ name: "write_file", arguments: { path: "browser-site/index.html", create_parents: true,
      content: '<!doctype html><meta charset="utf-8"><title>Browser task</title><style>body{font:18px system-ui;background:#f3f5fa;color:#172033;padding:48px}main{background:white;border-radius:20px;padding:32px;max-width:600px}button{font:inherit;padding:12px 24px;background:#365bf5;color:white;border:0;border-radius:12px}</style><main><h1>Conversation browser</h1><p>Trusted ref input proof</p><button id="confirm" onclick="document.querySelector(\'#result\').textContent=\'Confirmed\'">Confirm</button><p id="result">Ready</p></main>' } }),
    () => ({ name: "output_publish", arguments: { path: "browser-site", title: "Browser task" } }),
  ]);
  await send("Publish browser fixture"); await delivered();
  const artifacts = await app.gateway.api<{ artifacts: Array<{ id: string; kind: string }> }>("/artifacts?session_id=general");
  const output = artifacts.artifacts.find(item=>item.kind === "web"); assert.ok(output);
  const view = await app.gateway.api<{ url: string }>(`/outputs/${output.id}/view`);
  if(!baseline) await browserOutputEntry(app,evidence);
  const observe=(request:Parameters<typeof latestBrowser>[0])=>bridgeBrowser("browser_observe",{tab:latestBrowser(request,"tab").tab});
  stub.set([describeBrowser, () => bridgeBrowser("browser_open", { url: view.url }), observe, request=>{const call=actConfirm(request);const args=call.arguments.arguments as {steps:unknown[]};args.steps=[args.steps[0],args.steps[0]];return call;},observe,observe]);
  await send("Browse the fixture by ref"); await delivered();
  await browserContextCheck(app,evidence);
  agentTab = (await state()).tabs.find(tab=>tab.agent && tab.owner === "conversation:general")!; assert.ok(agentTab, JSON.stringify({ nativeError: await app.main("globalThis.browserAgentError"), toolRounds: stub.results.length }));
  assert.equal(agentTab.profile, "signed_out");
  if(process.env.BUTLER_BROWSER_CONTEXT_BYTES==='1') await browserProviderByteCheck(app,stub,agentTab.id,evidence,send,delivered);
  await app.call("activate", { id: agentTab.id });
  await app.page.reload();
  const proof = await app.main(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(agentTab.id)}).view.webContents.executeJavaScript("({result:document.querySelector('#result').textContent,width:innerWidth,height:innerHeight})")`);
  assert.deepEqual(proof, { result: "Confirmed", width: 1280, height: 800 }); traces.push({ proof });
  writeFileSync(join(evidence,"native-proof.json"),JSON.stringify({proof,loadAverage1m:loadavg()[0]}));
  if (process.env.BUTLER_BROWSER_SOAK === "1") await soakBrowser(app,stub,agentTab.id,evidence,send,delivered);
  const sessionView = await app.gateway.api<Record<string,unknown>>("/session-view?session_id=general");
  writeFileSync(join(evidence,"message-projection.json"),JSON.stringify({messages:(sessionView.messages as Array<Record<string,unknown>>).map(m=>({keys:Object.keys(m),role:m.role,turn:m.turn_id,updated:m.updated_at,rows:m.turn_activity_rows})),latest:sessionView.latest_turn},null,2));
  const rows: Array<Record<string,unknown>>=[];
  function collectRows(value:unknown) {
    if(!value || typeof value!=="object") return;
    if(!Array.isArray(value) && 'safe_tool_name' in value) rows.push(value as Record<string,unknown>);
    for(const child of Object.values(value)) collectRows(child);
  }
  collectRows(sessionView);
  const summaries=[];
  for(const row of rows.filter(row=>row.tool_result_id && row.tool_call_id)) {
    const turn=(sessionView.latest_turn as {id:string}).id;
    const raw=await app.gateway.api<{content:string}>(`/turns/${turn}/operations/${row.tool_call_id}/output?result_id=${row.tool_result_id}&offset=0`).catch(()=>null);
    if(row.safe_tool_name==="browser_act" && raw) {const receipt=JSON.parse(raw.content);assert.equal(receipt.steps.length,process.env.BUTLER_BROWSER_SOAK==="1"?1:process.env.BUTLER_BROWSER_CONTEXT_BYTES==="1"?10:2);assert.ok(receipt.steps.every((step:{status:string;still_file?:unknown})=>step.status==="completed" && step.still_file));}
    summaries.push({name:row.safe_tool_name,input:row.safe_input_label,keys:raw?Object.keys(JSON.parse(raw.content)):[],hasStill:raw?.content.includes('still_file'),size:raw?.content.length});
  }
  writeFileSync(join(evidence,"timeline-projection.json"),JSON.stringify(summaries,null,2));
  await settings("en", "light");
  await waitBrowser(()=>app.page.expression("Boolean(document.querySelector('[data-test-class=browser-step-still] img'))"), "real browser still before geometry");
  await app.page.expression("Promise.all([...document.querySelectorAll('[data-test-class=browser-step-still] img')].map(img=>img.decode()))");
  const stillGeometry = await app.page.expression<Array<{ width: number; height: number; boxWidth: number; boxHeight: number }>>("[...document.querySelectorAll('[data-test-class=browser-step-still] img')].map(img=>{const r=img.getBoundingClientRect(),p=img.parentElement.getBoundingClientRect();return {width:r.width,height:r.height,boxWidth:p.width,boxHeight:p.height}})");
  assert.ok(stillGeometry.length);
  for (const geometry of stillGeometry) {
    assert.ok(geometry.width <= 320 && geometry.width > 0);
    assert.ok(Math.abs(geometry.height - geometry.width * 800 / 1280) < 2);
    assert.ok(Math.abs(geometry.boxWidth - geometry.width) < 2 && Math.abs(geometry.boxHeight - geometry.height) < 2, "still box follows the image");
  }
  writeFileSync(join(evidence,"still-geometry.json"),JSON.stringify(stillGeometry));
  writeFileSync(join(evidence,"address-row-dom.json"),JSON.stringify(await app.page.expression("(()=>{const input=document.querySelector('#browser-address');const row=input?.parentElement?.parentElement?.parentElement;return {html:row?.outerHTML,text:row?.textContent,breadcrumbs:row?.querySelectorAll('[data-slot=breadcrumb]').length}})()")));

  writeFileSync(join(evidence,"native-capture.json"),JSON.stringify(await app.main(`(async()=>{const t=globalThis.browserAgentSubject.tabs.get(${JSON.stringify(agentTab.id)});const i=await t.view.webContents.capturePage(undefined,{stayHidden:true});return {size:i.getSize(),empty:i.isEmpty(),jpeg320:i.resize({width:320}).toJPEG(70).length,epoch:t.epoch,holder:t.holder,stills:t.stills}})()`)));
  await app.shot("timeline-debug");
  writeFileSync(join(evidence,"timeline-dom.json"),JSON.stringify(await app.page.expression(`({text:document.body.innerText,classes:[...document.querySelectorAll('[data-test-class]')].map(e=>e.getAttribute('data-test-class'))})`)));
  writeFileSync(join(evidence,"timeline-props.json"),JSON.stringify(await app.page.expression(`(()=>{const el=document.querySelector('[data-test-class="message assistant"]');let f=el?.[Object.keys(el).find(k=>k.startsWith('__reactFiber'))];const rows=[];for(;f;f=f.return){const p=f.memoizedProps;if(p?.message)rows.push({turn:p.message.turn_id,state:p.message.status,rows:p.message.turn_activity_rows,running:p.running});}return rows})()`)));
  if (!baseline) await waitBrowser(()=>app.page.expression("Boolean(document.querySelector('[data-test-class=browser-step-still] img'))"), "real browser still in timeline");
  await browserBoundaryChecks(app,agentTab.id,evidence);
  const mine = await app.call<string>("create", { url: "https://example.com" });
  assert.equal((await internal("tab.observe", mine)).reason, "not_your_tab");
  assert.equal((await internal("tab.observe", agentTab.id, {}, "other")).reason, "not_your_tab");
  await app.call("activate", { id: agentTab.id });
  for (const language of ["ko", "en"]) for (const theme of ["light", "dark"]) {
    await settings(language, theme);
    await browserGroupSnapshotChecks(app,agentTab.id,language,theme,evidence);
    await app.call("control", { id: agentTab.id, holder: "agent" });
    await app.shot(`${language}-${theme}-agent-1440`);
    await app.call("control", { id: agentTab.id, holder: "user", sticky: true });
    await app.shot(`${language}-${theme}-takeover-1440`);
    assert.equal((await internal("tab.observe", agentTab.id)).reason, "user_control");
    await app.call("control", { id: agentTab.id, holder: "agent" });
    await app.shot(`${language}-${theme}-timeline-still-1440`);
  }
  const observation = await internal("tab.observe", agentTab.id);
  assert.equal(observation.status, "ok");
  await app.main(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(agentTab.id)}).view.webContents.sendInputEvent({type:'mouseDown',x:100,y:100,button:'left',clickCount:1})`);
  await waitBrowser(async()=>(await state()).tabs.find(t=>t.id===agentTab.id)?.holder === "user", "native click takeover");
  stub.set([describeBrowser, ()=>bridgeBrowser("browser_wait_for_user", { tab: agentTab.id })]);
  await send("Wait for hand-back");
  await waitBrowser(async()=>(await state()).tabs.find(t=>t.id===agentTab.id)?.waiting === true, "durable user wait");
  await app.call("control", { id: agentTab.id, holder: "agent" });
  await delivered();
  const stale = await internal("tab.prepare", agentTab.id, { observation: observation.obs, steps: [{ action: "click", ref: observation.nodes.find((n:{name:string})=>n.name==="Confirm").ref }] });
  assert.equal(stale.reason, "stale_ref");
  await app.call("control", {id:agentTab.id,holder:"user",sticky:true});
  await waitBrowser(async()=>(await internal("tab.observe",agentTab.id)).reason === "user_control", "Rust mirror before hand-back race");
  await app.main(`(()=>{const browser=globalThis.browserAgentSubject;const execute=browser.execute;browser.execute=async function(frame){const result=await execute.call(this,frame);if(frame.op==='tab.wait'){this.execute=execute;this.control(frame.tab,'agent');}return result}})()`);
  stub.set([describeBrowser,()=>bridgeBrowser("browser_wait_for_user",{tab:agentTab.id})]);
  await send("Hand-back races durable wait admission."); await delivered();
  await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ access_mode: "ask_first" }) });
  stub.set([describeBrowser, ()=>bridgeBrowser("browser_observe", { tab: agentTab.id }), actConfirm]);
  await send("Approve the exact browser click");
  await waitBrowser(async()=>(await state()).tabs.find(t=>t.id===agentTab.id)?.waiting === true, "ask-first approval waiting");
  for (const language of ["ko", "en"]) for (const theme of ["light", "dark"]) { await settings(language,theme); await app.shot(`${language}-${theme}-approval-waiting-1440`); }
  const browser = await launchSmokeBrowser();
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await app.gateway.signIn(context); const phone = await context.newPage(); await phone.goto(app.gateway.url);
    await phone.getByRole("button", {name:"Show sidebar",exact:true}).click();
    await phone.getByText("General", { exact: true }).first().click();
    await phone.getByText("Confirm", { exact: false }).first().waitFor();
    assert.equal(await phone.locator('[data-test-class="browser-step-still"]').count(),0);
    assert.equal(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,"390px approval fits");
    for(const language of ["ko","en"])for(const theme of ["light","dark"]) {
      await app.gateway.api("/settings",{method:"PATCH",body:JSON.stringify({language,appearance_theme:theme})});
      await phone.reload();
      await phone.getByRole("button",{name:language==="ko"?"사이드바 보기":"Show sidebar",exact:true}).click();
      await phone.getByText(language==="ko"?"일반":"General",{exact:true}).first().click();
      await phone.getByRole("button",{name:language==="ko"?"이번만 허용":"Allow once",exact:true}).waitFor();
      await phone.getByText(language==="ko"?"127.0.0.1 · 로그인 없이":"127.0.0.1 · Without signing in",{exact:true}).waitFor();
      const cardText = await phone.locator('[data-test-class="composer-authority-decision"]').innerText();
      assert.ok(cardText.includes(language === "ko" ? "‘Confirm’ 버튼 클릭 · 127.0.0.1" : "Click the ‘Confirm’ button · 127.0.0.1"));
      assert.ok(!cardText.includes("click · button"));
      const authority = await app.gateway.api<any>("/authority-requests?session_id=general");
      const risk = authority.requests[0].approval.risk;
      assert.notEqual(risk,"high","plain click is outside always-confirm class");
      await phone.evaluate(()=>document.fonts.ready.then(()=>undefined));
      await phone.waitForFunction(()=>{
        const card=document.querySelector('[data-test-class="composer-authority-decision"]');
        if(!card)return false;
        return [card,...card.querySelectorAll('button')].every(node=>{
          const r=node.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.bottom<=innerHeight;
        });
      });
      assert.equal(await phone.locator('[data-test-class="browser-step-still"]').count(),0);
      assert.equal(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await phone.screenshot({path:join(evidence,`${language}-${theme}-phone-approval-390.png`)});
    }
    await phone.getByRole("button", { name: "Allow once", exact:true }).click();
    await delivered(); await context.close();
  } finally { await browser.close(); }
  await browserAuthorityChecks(app,stub,agentTab.id,send,delivered,evidence);
  await browserUiChecks(app,agentTab.id,evidence);
  await browserArchiveCheck(app,view.url,evidence);
  assert.ok(!stub.results.some(item=>item && typeof item==="object" && "stubFailure" in item),"all guided stub steps completed");
  traces.push({ loadAverage1m: loadavg()[0], tools: stub.results });
  writeFileSync(join(evidence,"acceptance.json"),JSON.stringify(traces,null,2));
  console.log(JSON.stringify({ status:"passed", loadAverage1m:loadavg()[0] }));
} finally {
  try {
  const oopifDiagnostic=await app.main("globalThis.oopifProof").catch(()=>null);if(oopifDiagnostic)writeFileSync(join(evidence,"oopif-diagnostic.json"),JSON.stringify(oopifDiagnostic,null,2));
  const db=new Database(join(app.gateway.butlerData,"agent-runtime/btcc.sqlite"),{readonly:true});
  const turns=db.query("SELECT turn_id,semantic_state,suspension_reason,revision FROM btcc_turns ORDER BY rowid DESC LIMIT 3").all();
  const authority=db.query("SELECT request_ref,decision,outcome,capability,close_reason FROM btcc_authority_requests ORDER BY rowid DESC LIMIT 3").all();
  const appdb=new Database(join(app.gateway.butlerData,"app-server/butler-client.sqlite"),{readonly:true});
  const staged=appdb.query("SELECT action_id,state,json_extract(event_json,'$.payload.metadata') AS metadata FROM app_transport_projection_staged_outbounds").all();
  const events=appdb.query("SELECT type,payload_json FROM events ORDER BY id DESC LIMIT 60").all();
  const queue=appdb.query("SELECT id,state,turn_id,claim_id,terminal_result_message_id,dispatched_message_id FROM session_queued_messages ORDER BY rowid DESC LIMIT 3").all();
  const delivery=db.query("SELECT turn_id,status,committed_turn_revision FROM btcc_delivery_outbox ORDER BY rowid DESC LIMIT 3").all();
  appdb.close();writeFileSync(join(evidence,"app-projection-state.json"),JSON.stringify({staged,events,queue,delivery},null,2));
  db.close();writeFileSync(join(evidence,"btcc-state.json"),JSON.stringify({turns,authority},null,2));
  writeFileSync(join(evidence,"final-state.json"),JSON.stringify({rustObserve:await internal("tab.observe",agentTab?.id).then((value:any)=>({status:value.status,reason:value.reason})).catch(()=>null),session:await app.gateway.api("/session-view?session_id=general").then((view:any)=>({latest:view.latest_turn})).catch(()=>null),authority:await app.gateway.api("/authority-requests?session_id=general").catch(()=>null),tabs:(await state()).tabs.map(({id,owner,epoch,holder,waiting})=>({id,owner,epoch,holder,waiting}))},null,2));
  writeFileSync(join(evidence,"trace.json"),JSON.stringify({ traces, toolResults: stub.results, nativeError: await app.main("globalThis.browserAgentError").catch(()=>null), renderer: await app.page.diagnostics().catch(()=>null) },null,2));
  const journal=await Bun.file(join(app.gateway.butlerData,"transcripts/butler_app-general.jsonl")).text().catch(()=>"");
  const outbounds=journal.trim().split("\n").filter(Boolean).map(line=>JSON.parse(line)).filter(event=>['outbound','delivery'].includes(event.type ?? event.kind)).map(event=>({kind:event.type ?? event.kind,event:event.eventId ?? event.event_id,action:event.payload?.actionId,ok:event.payload?.ok,error:event.payload?.error,metadata:event.payload?.metadata}));
  writeFileSync(join(evidence,"outbound-metadata.json"),JSON.stringify(outbounds,null,2));
  const inbound=[];
  for(const event of outbounds.filter(event=>event.metadata?.queueId)) for(const folder of ['processed','failed','processing']) {
    const value=await Bun.file(join(app.gateway.butlerData,'runtime/inbound-events',folder,`${event.metadata.queueId}.json`)).json().catch(()=>null);
    if(value) inbound.push({queue:event.metadata.queueId,folder,terminalClaim:value.metadata?.terminalClaimId,failure:value.metadata?.failure?.code});
  }
  writeFileSync(join(evidence,"inbound-claims.json"),JSON.stringify(inbound,null,2));
  } catch(error) {writeFileSync(join(evidence,"diagnostics-error.json"),JSON.stringify({error:String(error)}));}
  finally {await app.stop();}
}
