/** Real Electron observation budget, including frame acquisition and full response. */
import { strict as assert } from "node:assert";
import { loadavg } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app";
import { browserStub, describeBrowser, bridgeBrowser, latestBrowser } from "../support/browser-agent-stub";
const evidence=process.env.BUTLER_BROWSER_EVIDENCE;assert.ok(evidence);
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
  writeFileSync(join(evidence,"observe-perf.json"),JSON.stringify({p95,rows},null,2));
  console.log(JSON.stringify({p95,loadAverage1m:loadavg()[0]}));assert.ok(p95<=250,`observe p95 ${p95} exceeds 250ms`);
}finally{await app.stop()}
