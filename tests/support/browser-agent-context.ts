import { strict as assert } from "node:assert";
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadavg } from "node:os";
import { describeBrowser, bridgeBrowser, latestBrowser, type browserStub } from "./browser-agent-stub";
import type { browserAgentApp } from "./browser-agent-app";

/** Provider context folds old observations; durable tool results stay complete. */
export async function browserContextCheck(app:Awaited<ReturnType<typeof browserAgentApp>>,evidence:string) {
  const request=app.gateway.stubModelCalls.filter(call=>call.stream).at(-1)!;
  const messages=request.messages.filter(message=>(message as {role?:string}).role==='tool') as Array<{content:string}>;
  const full=messages.map(message=>JSON.parse(message.content)).filter(value=>value.output?.schema==='butler.browser-observation.v1');
  const old=messages.map(message=>JSON.parse(message.content)).filter(value=>value.output?.status==='superseded');
  assert.ok(!JSON.stringify(messages.map(message=>JSON.parse(message.content))).includes('still_file'),'desktop still metadata never reaches model context');
  assert.equal(full.length,1,"only the newest observation per tab stays full");
  assert.equal(old.length,2,"older observations are superseded");
  assert.ok(full[0].output.untrusted_content.text.includes('Confirm'));
  const view=await app.gateway.api<{latest_turn:{id:string}}>("/session-view?session_id=general");
  const db=new Database(join(app.gateway.butlerData,"agent-runtime/btcc.sqlite"),{readonly:true});
  try {
    const records=db.query("SELECT result_json FROM btcc_guided_tool_calls WHERE turn_id=?1 AND tool_name='browser_observe'").all(view.latest_turn.id) as Array<{result_json:string}>;
    assert.equal(records.length,3);
    const acts=db.query("SELECT result_json FROM btcc_guided_tool_calls WHERE turn_id=?1 AND tool_name='browser_act'").all(view.latest_turn.id) as Array<{result_json:string}>;
    assert.ok(acts.length && acts.every(record=>record.result_json.includes('still_file')),'durable desktop still metadata is retained');
    assert.ok(records.every(record=>record.result_json.includes('butler.browser-observation.v1') && record.result_json.includes('Confirm')),"journaled observations remain immutable and complete");
    writeFileSync(join(evidence,"context-newest-full.json"),JSON.stringify({full:full.length,superseded:old.length,journalFull:records.length,images:request.body.messages && JSON.stringify(request.body.messages).includes('image_url')},null,2));
  }finally{db.close()}
}

/** Both total wire bytes and the final prompt are reported; no cached-token inference. */
export async function browserProviderByteCheck(app:Awaited<ReturnType<typeof browserAgentApp>>,stub:ReturnType<typeof browserStub>,tab:string,evidence:string,send:(text:string)=>Promise<void>,delivered:()=>Promise<void>) {
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
    const requests=app.gateway.stubModelCalls.slice(start),last=requests.filter(request=>request.stream).at(-1)!;
    const tools=last.messages.filter(message=>(message as {role?:string}).role==='tool') as Array<{content:string}>;
    const outputs=tools.map(message=>JSON.parse(message.content).output);
    assert.equal(outputs.filter(value=>value?.schema==='butler.browser-observation.v1').length,1);
    assert.equal(outputs.filter(value=>value?.status==='superseded').length,count/10-1);
    const receipts=outputs.flatMap(value=>value?.steps ?? []);
    assert.equal(receipts.length,count);assert.ok(receipts.every(step=>step.status==='completed'));
    assert.ok(!JSON.stringify(last.body).includes('image_url'));
    assert.ok(!JSON.stringify(outputs).includes('still_file'),'desktop still metadata is absent from every provider prompt');
    rows.push({count,requests:requests.length,totalWireBytes:requests.reduce((sum,request)=>sum+Buffer.byteLength(JSON.stringify(request.body)),0),finalPromptBytes:Buffer.byteLength(JSON.stringify(last.body)),completed:receipts.length,fullObservations:1,superseded:count/10-1,loadAverage1m:loadavg()[0]});
  }
  const totalRatio=rows[1]!.totalWireBytes/rows[0]!.totalWireBytes,finalPromptRatio=rows[1]!.finalPromptBytes/rows[0]!.finalPromptBytes;
  writeFileSync(join(evidence,'provider-send-bytes.json'),JSON.stringify({rows,totalRatio,finalPromptRatio,budgetRatio:1.3,definition:'all provider request bodies sent during each fixture Turn; final prompt shown separately'},null,2));
  assert.ok(totalRatio<=1.3,`provider-send bytes ratio ${totalRatio} exceeds 1.3`);
}
