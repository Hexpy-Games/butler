import { strict as assert } from "node:assert";
import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { browserAgentApp } from "./browser-agent-app";

/** Provider context folds old observations; durable tool results stay complete. */
export async function browserContextCheck(app:Awaited<ReturnType<typeof browserAgentApp>>,evidence:string) {
  const request=app.gateway.stubModelCalls.filter(call=>call.stream).at(-1)!;
  const messages=request.messages.filter(message=>(message as {role?:string}).role==='tool') as Array<{content:string}>;
  const full=messages.map(message=>JSON.parse(message.content)).filter(value=>value.output?.schema==='butler.browser-observation.v1');
  const old=messages.map(message=>JSON.parse(message.content)).filter(value=>value.output?.status==='superseded');
  assert.equal(full.length,1,"only the newest observation per tab stays full");
  assert.equal(old.length,2,"older observations are superseded");
  assert.ok(full[0].output.untrusted_content.text.includes('Confirm'));
  const view=await app.gateway.api<{latest_turn:{id:string}}>("/session-view?session_id=general");
  const db=new Database(join(app.gateway.butlerData,"agent-runtime/btcc.sqlite"),{readonly:true});
  try {
    const records=db.query("SELECT result_json FROM btcc_guided_tool_calls WHERE turn_id=?1 AND tool_name='browser_observe'").all(view.latest_turn.id) as Array<{result_json:string}>;
    assert.equal(records.length,3);
    assert.ok(records.every(record=>record.result_json.includes('butler.browser-observation.v1') && record.result_json.includes('Confirm')),"journaled observations remain immutable and complete");
    writeFileSync(join(evidence,"context-newest-full.json"),JSON.stringify({full:full.length,superseded:old.length,journalFull:records.length,images:request.body.messages && JSON.stringify(request.body.messages).includes('image_url')},null,2));
  }finally{db.close()}
}
