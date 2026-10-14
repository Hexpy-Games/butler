/** Captures the existing browser and conversation before the P2a-2 UI change. */
import { strict as assert } from "node:assert";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { browserAgentApp } from "../support/browser-agent-app";
const evidence=process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence); mkdirSync(evidence,{recursive:true});
const app=await browserAgentApp(evidence,()=>null,process.env.BUTLER_BROWSER_BASELINE_DIST ?? resolve(evidence,"../baseline-dist"));
const fixture=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response("<title>Browser task</title><h1>Conversation browser</h1><button>Confirm</button>",{headers:{"content-type":"text/html"}})});
try {
  await app.call("open"); const id=await app.call<string>("create",{owner:"conversation:general",url:`http://127.0.0.1:${fixture.port}/`});
  for(const language of ["ko","en"]) for(const theme of ["light","dark"]) {
    await app.gateway.api("/settings",{method:"PATCH",body:JSON.stringify({language,appearance_theme:theme})}); await app.page.reload();
    await app.page.waitForFunction(()=>Boolean(document.querySelector('[data-test-class="app-sidebar"]')));
    await app.call("activate",{id}); await app.click(language==="ko"?"브라우저":"Browser");
    await app.page.waitForFunction(()=>Boolean(document.querySelector('[data-test-class="browser-area"]')));
    await app.shot(`${language}-${theme}-browser-before-1440`);
  }
} finally { fixture.stop(true); await app.stop(); }
