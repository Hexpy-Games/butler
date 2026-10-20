/** Real Electron observation budget, including frame acquisition and full response. */
import { strict as assert } from "node:assert";
import { loadavg } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { expectBrowserStills } from "../support/browser-still-delivery";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app";
import { browserStub, describeBrowser, bridgeBrowser, latestBrowser } from "../support/browser-agent-stub";
const evidence=process.env.BUTLER_BROWSER_EVIDENCE;assert.ok(evidence);
// Normal full-observe p95 166–186 ms (issue 694 A/B); incident at ~10x.
const OBSERVE_INCIDENT_MS=2000;
const reportOnly=process.env.BUTLER_BROWSER_PERF_REPORT_ONLY==='1';
const stub=browserStub(), app=await browserAgentApp(evidence,stub.handler);
try {
  await app.gateway.api("/settings",{method:"PATCH",body:JSON.stringify({access_mode:"full_access"})});
  stub.set([()=>({name:"write_file",arguments:{path:"perf-site/index.html",content:"<!doctype html><main>Ready</main>",create_parents:true}}),()=>({name:"output_publish",arguments:{path:"perf-site",title:"Browser perf"}})]);
  await app.gateway.api("/messages",{method:"POST",body:JSON.stringify({chat_id:"general",text:"Publish browser perf",client_message_id:crypto.randomUUID()})});
  const delivered=()=>waitBrowser(async()=>(await app.gateway.api<any>("/session-view?session_id=general")).latest_turn?.state==="delivered","perf fixture delivered");
  await delivered();
  const artifacts=await app.gateway.api<any>("/artifacts?session_id=general");
  const output=artifacts.artifacts.find((item:any)=>item.kind==="web");assert.ok(output);
  const view=await app.gateway.api<{url:string}>(`/outputs/${output.id}/view`);
  stub.set([describeBrowser,()=>bridgeBrowser("browser_open",{url:view.url}),request=>bridgeBrowser("browser_observe",{tab:latestBrowser(request,"tab").tab})]);
  const prior=(await app.gateway.api<any>("/session-view?session_id=general")).latest_turn.id;
  await app.gateway.api("/messages",{method:"POST",body:JSON.stringify({chat_id:"general",text:"Open browser perf",client_message_id:crypto.randomUUID()})});
  await waitBrowser(async()=>(await app.gateway.api<any>("/session-view?session_id=general")).latest_turn?.id!==prior,"new perf turn");await delivered();
  const tabs=await app.call<{tabs:Array<{id:string;agent:boolean}>}>("state");const tab=tabs.tabs.find(t=>t.agent)!.id;
  await app.main(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab)}).view.webContents.executeJavaScript("(()=>{document.body.innerHTML='<style>body{margin:0;font:12px system-ui;color:black;background:white}.row{height:24px}</style><main></main>';const root=document.querySelector('main');for(let n=0;n<10000;n++){const e=document.createElement(n<200?'button':'div');e.className='row';e.id='node-'+n;e.textContent='Item '+n;root.append(e)}})()")`);
  const admin=JSON.parse(await Bun.file(join(app.gateway.butlerData,"app/runtime/auth/local-admin.json")).text()).secret as string;
  const rows=[];
  for(let index=0;index<30;index++) {
      const before=performance.now(),loadAverage1m=loadavg()[0];
    const value=await app.gateway.api<any>("/internal/browser/calls",{method:"POST",headers:{"x-butler-admin":admin},body:JSON.stringify({op:"tab.observe",session:"general",tab,args:{}})});
    const wallMs=performance.now()-before;
    assert.equal(value.status,"ok");assert.equal(value.totals.interactive+value.totals.below_fold,200);
    assert.equal(value.nodes.filter((node:any)=>node.interactive).length,200);
    assert.deepEqual(value.nodes.filter((node:any)=>node.interactive).map((node:any)=>node.name),Array.from({length:200},(_,n)=>n===0 && index>0?`Latest ${index-1}`:`Item ${n}`));
    assert.equal(value.nodes[0].name,index===0?"Item 0":`Latest ${index-1}`);
    rows.push({wallMs,scriptMs:value.scriptMs,loadAverage1m,count:200,bytes:Buffer.byteLength(JSON.stringify(value))});
    await app.main(`globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab)}).view.webContents.executeJavaScript("document.getElementById('node-0').textContent='Latest ${index}'")`);
  }
  const sorted=rows.map(row=>row.wallMs).sort((a,b)=>a-b),p95=sorted[Math.ceil(rows.length*.95)-1]!;
  writeFileSync(join(evidence,"observe-perf.json"),JSON.stringify({p95,rows,budgetMs:OBSERVE_INCIDENT_MS,overBudget:p95>OBSERVE_INCIDENT_MS,reportOnly},null,2));
  console.log(JSON.stringify({p95,loadAverage1m:loadavg()[0],reportOnly}));if(!reportOnly) assert.ok(p95<=OBSERVE_INCIDENT_MS,`observe p95 ${p95} exceeds ${OBSERVE_INCIDENT_MS}ms incident threshold`);
  const stopProofs:unknown[]=[];
  const acts:Array<Parameters<typeof expectBrowserStills>[1]>=[];
  const latencies:Record<string,Array<{ms:number;loadAverage1m:number;settleMs?:number;overheadMs?:number}>>={noop:[],act:[],stop:[]};
  const call=(op:string,args:unknown={},call_id?:string)=>app.gateway.api<any>("/internal/browser/calls",{method:"POST",headers:{"x-butler-admin":admin},body:JSON.stringify({op,session:"general",tab,args,call_id})});
  for(let n=0;n<30;n++) {
    let start=performance.now(),loadAverage1m=loadavg()[0];
    const tabs=await call('tabs.list');latencies.noop.push({ms:performance.now()-start,loadAverage1m});
    assert.equal(tabs.tabs.length,1);assert.equal(tabs.tabs[0].id,tab);
    const o=await call('tab.observe'),args={observation:o.obs,steps:[{action:'click',ref:o.nodes[0].ref}]};
    const prepared=await call('tab.prepare',args);assert.equal(prepared.status,'ok');
    start=performance.now();loadAverage1m=loadavg()[0];
    const act=await call('tab.act',{...args,prepared_steps:prepared.steps});
    const ms=performance.now()-start;assert.ok(Number.isFinite(act.settleMs)&&act.settleMs>=0&&act.settleMs<=ms,'each act exposes its measured settle wait');
    latencies.act.push({ms,settleMs:act.settleMs,overheadMs:ms-act.settleMs,loadAverage1m});
    assert.equal(act.steps.length,1);assert.equal(act.steps[0].status,'completed');acts.push(act);
    const batch={...args,steps:Array.from({length:10},()=>args.steps[0])};
    const batchPrepared=await call('tab.prepare',batch);assert.equal(batchPrepared.status,'ok');
    const callId=crypto.randomUUID(),pending=call('tab.act',{...batch,prepared_steps:batchPrepared.steps},callId);
    await waitBrowser(()=>app.main<boolean>(`Boolean(globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab)}).busy)`),'active batch before stop');
    start=performance.now();loadAverage1m=loadavg()[0];
    const stop=await call('tab.cancel',{call_id:callId});latencies.stop.push({ms:performance.now()-start,loadAverage1m});assert.equal(stop.status,'ok');
    const stopped=await pending;stopProofs.push(stopped);acts.push(stopped);assert.equal(stopped.steps.length,10);
    const first=stopped.steps.findIndex((step:any)=>step.status==='not_dispatched');
    assert.ok(first>=0,'stop fences undispatched steps');
    assert.ok(stopped.steps.slice(first).every((step:any)=>step.status==='not_dispatched'));
    assert.ok(stopped.steps.slice(0,first).every((step:any)=>step.status==='completed'));
  }
  const stills=[];
  for(const act of acts) stills.push(await expectBrowserStills(app.gateway,act));
  assert.equal(stills.length,acts.length,"every act checked for complete still delivery");
  // Normal act p95 53.5 ms (PR 1382); incident at roughly 20x.
  const ACT_INCIDENT_MS=1000;
  const budgets={actIncident:ACT_INCIDENT_MS,stop:100},failures:string[]=[],operationP95:Record<string,number>={};
  // Normal no-op p95 2.10–2.72 ms (issue 694 A/B); incident at roughly 20x.
  const NOOP_INCIDENT_MS=50;
  for(const [name,samples]of Object.entries(latencies)) {
    const sorted=samples.map(row=>row.ms).sort((a,b)=>a-b),p95=sorted[Math.ceil(sorted.length*.95)-1]!;operationP95[name]=p95;
    if(name==="stop" && p95>budgets.stop)failures.push(`${name} p95 ${p95} exceeds ${budgets.stop}`);
  }
  const quantiles=(values:number[])=>{const sorted=values.sort((a,b)=>a-b);return {p50:sorted[Math.ceil(sorted.length*.5)-1]!,p95:sorted[Math.ceil(sorted.length*.95)-1]!}};
  const actOverhead=quantiles(latencies.act!.map(row=>row.overheadMs!)),actTotal=quantiles(latencies.act!.map(row=>row.ms));
  // Watches (printed, never failing): per-tool-call overhead (total minus measured settle) and total act p95.
  const actOverheadWatchMs=20,actTotalWatchMs=50;
  if(actTotal.p95>budgets.actIncident)failures.push(`act p95 ${actTotal.p95} exceeds ${budgets.actIncident}ms incident threshold`);
  console.log(JSON.stringify({actOverhead,actOverheadWatchMs,actOverheadOverWatch:actOverhead.p95>actOverheadWatchMs,actTotal,actTotalWatchMs,actTotalOverWatch:actTotal.p95>actTotalWatchMs,loadAverage1m:loadavg()[0]}));
  writeFileSync(join(evidence,'operation-perf.json'),JSON.stringify({actOverhead,actOverheadWatchMs,actTotal,actTotalWatchMs,operationP95,latencies,stopProofs,stills,budgets,noopIncidentMs:NOOP_INCIDENT_MS,failures,reportOnly},null,2));
  if(!reportOnly) {
    assert.deepEqual(failures,[],'browser operation budgets');
    assert.ok(operationP95.noop!<=NOOP_INCIDENT_MS,`noop p95 ${operationP95.noop} exceeds ${NOOP_INCIDENT_MS}ms incident threshold`);
  }
}finally{await app.stop()}
