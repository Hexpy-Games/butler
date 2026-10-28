import { strict as assert } from "node:assert";
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { providerArm, assertBrowserBodies, journalSteps } from "./browser-provider-bytes";
import { describeBrowser, bridgeBrowser, latestBrowser, type browserStub } from "./browser-agent-stub";
import type { browserAgentApp } from "./browser-agent-app";

/** Provider context folds old observations; durable tool results stay complete. */
export async function browserContextCheck(app:Awaited<ReturnType<typeof browserAgentApp>>,evidence:string, sessionId:string) {
  // Provider calls reach the offline vision carrier when the App runs one, else the gateway stub.
  const calls=app.visionRequests ?? app.gateway.stubModelCalls;
  // The turn's last round; title and grouping calls run beside it without tool results.
  const request=calls.filter(call=>call.stream && call.messages.some(message=>(message as {role?:string}).role==='tool')).at(-1)!;
  const messages=request.messages.filter(message=>(message as {role?:string}).role==='tool') as Array<{content:string}>;
  const full=messages.map(message=>JSON.parse(message.content)).filter(value=>value.output?.schema==='butler.browser-observation.v1' && value.output?.status!=='superseded');
  const old=messages.map(message=>JSON.parse(message.content)).filter(value=>value.output?.status==='superseded');
  assert.ok(!JSON.stringify(messages.map(message=>JSON.parse(message.content))).includes('still_file'),'desktop still metadata never reaches model context');
  assert.equal(full.length+old.length,3,"all observations remain represented");
  assert.ok(pageOf(full.map(value=>value.output),full.at(-1).output).untrusted_content.text.includes('Confirm'),'the newest observation reads the page');
  assertBrowserBodies(calls);
  const view=await app.gateway.api<{latest_turn:{id:string}}>(`/session-view?session_id=${sessionId}`);
  const db=new Database(join(app.gateway.butlerData,"agent-runtime/btcc.sqlite"),{readonly:true});
  try {
    const records=db.query("SELECT result_json FROM btcc_guided_tool_calls WHERE turn_id=?1 AND tool_name='browser_observe'").all(view.latest_turn.id) as Array<{result_json:string}>;
    assert.equal(records.length,3);
    const acts=db.query("SELECT result_json FROM btcc_guided_tool_calls WHERE turn_id=?1 AND tool_name='browser_act'").all(view.latest_turn.id) as Array<{result_json:string}>;
    // c418a4c42: stills arrive after the act; the journaled act keeps the durable still receipt.
    assert.ok(acts.length && acts.every(record=>record.result_json.includes('still_pending')),'durable desktop still receipt is retained');
    const journaled=records.map(record=>{const value=JSON.parse(record.result_json);return value.output ?? value});
    assert.ok(journaled.every(output=>output.schema==='butler.browser-observation.v1' && output.status!=='superseded' && pageOf(journaled,output).untrusted_content.text.includes('Confirm')),"journaled observations remain immutable and complete");
    writeFileSync(join(evidence,"context-newest-full.json"),JSON.stringify({full:full.length,superseded:old.length,journalFull:records.length,images:request.body.messages && JSON.stringify(request.body.messages).includes('image_url')},null,2));
  }finally{db.close()}
}

/** The full observation an observation reads as: a change list (delta_of, 0614e1cec) names its base, back to a full listing in the same set. */
function pageOf(outputs:Array<{obs:string;delta_of?:string;untrusted_content:{text:string}}>,output:typeof outputs[number]) {
  const seen=new Set<string>();
  for(let page:typeof output|undefined=output;page;page=outputs.find(value=>value.obs===page!.delta_of)) {
    if(!page.delta_of)return page;
    assert.ok(!seen.has(page.obs) && page.untrusted_content.text.includes(`since ${page.delta_of}`),`${page.obs} names its base ${page.delta_of}`);
    seen.add(page.obs);
  }
  assert.fail(`${output.obs} resolves to a full observation`);
}

/** Both total wire bytes and the final prompt are reported; no cached-token inference. */
export async function browserProviderByteCheck(app:Awaited<ReturnType<typeof browserAgentApp>>,stub:ReturnType<typeof browserStub>,tab:string,evidence:string,send:(text:string)=>Promise<void>,delivered:()=>Promise<void>,sessionId:string) {
  const rows=[];
  for(const count of [10,40]) {
    const calls: Array<(request:Parameters<typeof latestBrowser>[0])=>ReturnType<typeof bridgeBrowser>>=[describeBrowser];
    for(let chunk=0;chunk<count/10;chunk++) {
      calls.push(()=>bridgeBrowser('browser_observe',{tab}));
      calls.push(request=>{
        const o=latestBrowser(request,'obs'),text=(o.untrusted_content as {text:string}).text;
        const ref=/button "Confirm" \[([^\]]+)\]/u.exec(text)?.[1];assert.ok(ref);
        return bridgeBrowser('browser_act',{tab,observation:o.obs,steps:Array.from({length:10},()=>({action:'hover',ref}))});
      });
    }
    stub.set(calls);
    const start=app.gateway.stubModelCalls.length;
    await send(`Observe and perform exactly ${count} hover steps by fresh refs.`);await delivered();
    const requests=app.gateway.stubModelCalls.slice(start);
    assertBrowserBodies(requests);
    const view=await app.gateway.api<{latest_turn:{id:string}}>(`/session-view?session_id=${sessionId}`);
    const receipts=journalSteps(app.gateway.butlerData,view.latest_turn.id);
    assert.equal(receipts.length,count,"all receipts remain complete in the journal");
    assert.ok(receipts.every(step=>step.status==='completed' && step.still_file));
    const last=requests.filter(request=>request.stream).at(-1)!;
    const outputs=last.messages.filter((message:any)=>message.role==='tool').map((message:any)=>JSON.parse(message.content).output);
    const contextCompleted=outputs.filter(value=>value?.schema==='butler.browser-action.v1').reduce((sum,value)=>{
      if(Array.isArray(value.steps))return sum+value.steps.length;
      const summary=/^(\d+)\/(\d+) completed$/u.exec(value.steps);assert.ok(summary);
      return sum+Number(summary[1]);
    },0);
    assert.equal(contextCompleted,count,"full and stubbed action receipts match the journal");
    rows.push({...providerArm(count,requests),completed:receipts.length});
  }
  const growth=rows[1]!.maxStreamingBodyBytes-rows[0]!.maxStreamingBodyBytes;
  const settings=await app.gateway.api<{model:string}>("/settings");
  const catalog=await app.gateway.api<{models:Array<{model_ref:string;context_window_tokens?:number}>}>("/model-catalog");
  const model=catalog.models.find(model=>model.model_ref===settings.model);
  assert.ok(model,'scenario model exists in catalog');
  const byteGuard=Math.min(4*1024*1024,Math.max(192*1024,(model.context_window_tokens ?? 200000)*2))/4;
  writeFileSync(join(evidence,'provider-send-bytes.json'),JSON.stringify({rows,growth,budgets:{growth:byteGuard,prefixRewrite:0},definition:'streaming maximum bodies and per-round prefix rewrite; aggregate reported only'},null,2));
  assert.ok(growth<=byteGuard,`Gate A: streaming body growth ${growth} exceeds ${byteGuard} B`);
  for(const arm of rows) {
    const prunes=arm.rounds.filter(round=>round.rewrittenBytes>0);
    assert.ok(prunes.length<=1,`Gate B: ${arm.count} steps has ${prunes.length} prunes in one batch`);
    for(const round of arm.rounds.filter(round=>!prunes.includes(round))) assert.equal(round.rewrittenBytes,0);
  }

}
