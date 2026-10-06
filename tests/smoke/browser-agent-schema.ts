/** Paired real provider schema: the same build with browsing disabled/enabled. */
import {strict as assert} from "node:assert";
import {writeFileSync,mkdirSync} from "node:fs";
import {join} from "node:path";
import {loadavg} from "node:os";
import {browserAgentApp,waitBrowser} from "../support/browser-agent-app";
import {browserStub} from "../support/browser-agent-stub";
const evidence=process.env.BUTLER_BROWSER_EVIDENCE;assert.ok(evidence);mkdirSync(evidence,{recursive:true});
const prior=process.env.BUTLER_BROWSER_DISABLED;
const schemas:Array<{enabled:boolean;bytes:number;tools:unknown;loadAverage1m:number}>=[];
try {
  for(const enabled of [false,true]) {
    if(enabled)delete process.env.BUTLER_BROWSER_DISABLED;else process.env.BUTLER_BROWSER_DISABLED="1";
    const stub=browserStub(),app=await browserAgentApp(join(evidence,enabled?"enabled":"disabled"),stub.handler);
    try {
      await app.gateway.api("/messages",{method:"POST",body:JSON.stringify({chat_id:"general",text:"Reply briefly.",client_message_id:crypto.randomUUID()})});
      await waitBrowser(async()=>(await app.gateway.api<any>("/session-view?session_id=general")).latest_turn?.state==="delivered","paired provider turn");
      const request=app.gateway.stubModelCalls.find(request=>request.body.stream);assert.ok(request);
      const tools=request.body.tools;assert.ok(Array.isArray(tools));
      assert.ok(!JSON.stringify(tools).includes('"name":"browser_'),"browser tools remain progressive, outside default schemas");
      schemas.push({enabled,tools,bytes:Buffer.byteLength(JSON.stringify(tools)),loadAverage1m:loadavg()[0]});
    }finally{await app.stop()}
  }
  const [baseline,current]=schemas;assert.ok(baseline && current);
  const deltaPercent=100*(current.bytes-baseline.bytes)/baseline.bytes;
  writeFileSync(join(evidence,"paired-default-schema.json"),JSON.stringify({baseline:"same candidate, browsing disabled",deltaPercent,schemas},null,2));
  assert.deepEqual(current.tools,baseline.tools,"full paired default schemas stay identical");
  assert.ok(deltaPercent<=1);
  console.log(JSON.stringify({baseline:baseline.bytes,current:current.bytes,deltaPercent,loadAverage1m:loadavg()[0]}));
}finally{if(prior===undefined)delete process.env.BUTLER_BROWSER_DISABLED;else process.env.BUTLER_BROWSER_DISABLED=prior}
