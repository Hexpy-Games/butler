// test-category: format-pin
/** Progressive browser discovery leaves the default provider schema unchanged. */
import {strict as assert} from "node:assert";
import {writeFileSync,mkdirSync} from "node:fs";
import {join} from "node:path";
import {loadavg} from "node:os";
import {browserAgentApp,waitBrowser} from "../support/browser-agent-app";
import {browserStub,describeBrowser} from "../support/browser-agent-stub";
const evidence=process.env.BUTLER_BROWSER_EVIDENCE;assert.ok(evidence);mkdirSync(evidence,{recursive:true});
const stub=browserStub(),app=await browserAgentApp(evidence,stub.handler);
try {
  const schemas:Array<{bytes:number;tools:unknown;loadAverage1m:number}>=[];
  for(const discover of [false,true]) {
    if(discover)stub.set([describeBrowser]);
    const start=app.gateway.stubModelCalls.length;
    const prior=(await app.gateway.api<any>("/session-view?session_id=general")).latest_turn?.id;
    await app.gateway.api("/messages",{method:"POST",body:JSON.stringify({chat_id:"general",text:discover?"Describe browser tools.":"Reply briefly.",client_message_id:crypto.randomUUID()})});
    await waitBrowser(async()=>{const turn=(await app.gateway.api<any>("/session-view?session_id=general")).latest_turn;return turn?.id!==prior && turn?.state==="delivered"},"provider schema turn");
    const request=app.gateway.stubModelCalls.slice(start).find(request=>request.stream);assert.ok(request);
    const tools=request.body.tools;assert.ok(Array.isArray(tools));
    assert.ok(!JSON.stringify(tools).includes('"name":"browser_'),"browser tools stay outside default schemas");
    schemas.push({tools,bytes:Buffer.byteLength(JSON.stringify(tools)),loadAverage1m:loadavg()[0]});
  }
  assert.match(JSON.stringify(stub.results),/browser_open/u,"progressive discovery exposes browser tools");
  const [baseline,current]=schemas;assert.ok(baseline && current);
  const deltaPercent=100*(current.bytes-baseline.bytes)/baseline.bytes;
  writeFileSync(join(evidence,"paired-default-schema.json"),JSON.stringify({baseline:"before progressive discovery",deltaPercent,schemas},null,2));
  assert.deepEqual(current.tools,baseline.tools,"default schemas stay identical after discovery");
  assert.ok(deltaPercent<=1);
  console.log(JSON.stringify({baseline:baseline.bytes,current:current.bytes,deltaPercent,loadAverage1m:loadavg()[0]}));
}finally{await app.stop()}
