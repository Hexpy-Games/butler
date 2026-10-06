/** Disabled browser: no model-facing names, no host, denial in Electron. */
import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app";
import { browserStub, describeBrowser, bridgeBrowser } from "../support/browser-agent-stub";
const evidence=process.env.BUTLER_BROWSER_EVIDENCE;assert.ok(evidence);mkdirSync(evidence,{recursive:true});
assert.equal(process.env.BUTLER_BROWSER_DISABLED,"1");
const stub=browserStub(), app=await browserAgentApp(evidence,stub.handler);
try {
  stub.set([describeBrowser,()=>bridgeBrowser("browser_open",{url:"https://example.com"})]);
  await app.gateway.api("/messages",{method:"POST",body:JSON.stringify({chat_id:"general",text:"Try disabled browser tools",client_message_id:crypto.randomUUID()})});
  await waitBrowser(async()=>(await app.gateway.api<any>("/session-view?session_id=general")).latest_turn?.state==="delivered","disabled browser denial delivered");
  for(const request of app.gateway.stubModelCalls) assert.ok(!JSON.stringify(request.body.tools).includes('"name":"browser_'),"zero disabled browser schemas");
  const results=JSON.stringify(stub.results);assert.ok(!results.includes('"name":"browser_open"'),"disabled describe returns no browser schema");
  assert.match(results,/tool_not_admitted|not_found|not_allowed|unknown_tool/u);
  const state=await app.call<any>("state");assert.equal(state.enabled,false);assert.deepEqual(state.tabs,[]);
  const denial=await app.main<any>("globalThis.browserAgentSubject.execute({op:'tab.open',session:'general',args:{url:'https://example.com'}})");
  assert.equal(denial.reason,"browsing_disabled");
  writeFileSync(join(evidence,"disabled.json"),JSON.stringify({schemas:0,denial,state},null,2));
}finally{await app.stop()}
