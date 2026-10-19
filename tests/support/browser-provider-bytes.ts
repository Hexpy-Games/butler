import { strict as assert } from "node:assert";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { loadavg } from "node:os";
import type { StubModelRequest } from "./native-app-server";

const bytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value));
const buffer=(value:unknown)=>Buffer.from(JSON.stringify(value));
function lcp(left:Buffer,right:Buffer) {
  let index=0;while(index<Math.min(left.length,right.length) && left[index]===right[index])index++;
  return index;
}
export function providerArm(count:number,requests:StubModelRequest[]) {
  const streaming=requests.filter(request=>request.stream);
  const rounds=streaming.map((request,index)=>{
    const previous=streaming[index-1],body=buffer(request.body);
    const appendedBytes=previous?bytes(request.messages.slice(previous.messages.length))-2+(request.messages.length>previous.messages.length?1:0):0;
    const lcpWithPrev=previous?lcp(body,buffer(previous.body)):body.length;
    const prefix=previous?buffer(request.messages.slice(0,previous.messages.length)):null;
    const rewrittenBytes=previous && prefix?prefix.length-lcp(prefix,buffer(previous.messages)):0;
    return {round:index+1,bodyBytes:body.length,appendedBytes,lcpWithPrev,rewrittenBytes};
  });
  const max=streaming[rounds.reduce((best,row,index)=>row.bodyBytes>rounds[best]!.bodyBytes?index:best,0)]!;
  const names=new Map<string,string>();
  const maxBodyMessages=max.messages.map((message:any,index)=>{
    for(const call of message.tool_calls ?? []) {
      const name=call.function?.name ?? call.name;
      names.set(call.id,name==='tool_call'?JSON.parse(call.function.arguments).id.replace('native:',''):name);
    }
    return {index,role:message.role,tool:message.name ?? names.get(message.tool_call_id),bytes:bytes(message)};
  });
  return {count,requests:requests.length,streamingRequests:streaming.length,
    streamingWireBytes:requests.filter(request=>request.stream).reduce((sum,request)=>sum+bytes(request.body),0),
    nonStreamingWireBytes:requests.filter(request=>!request.stream).reduce((sum,request)=>sum+bytes(request.body),0),
    totalWireBytes:requests.reduce((sum,request)=>sum+bytes(request.body),0),
    maxStreamingBodyBytes:bytes(max.body),maxBodyMessages,rounds,loadAverage1m:loadavg()[0],
    operationResultReferences:JSON.stringify(max.body).split('butler.operation-result-reference.v1').length-1};
}

export function journalSteps(data:string,turn:string):Array<{status:string;still_file?:unknown}> {
  const db=new Database(join(data,"agent-runtime/btcc.sqlite"),{readonly:true});
  try {
    const records=db.query("SELECT result_json FROM btcc_guided_tool_calls WHERE turn_id=?1 AND tool_name='browser_act' ORDER BY rowid").all(turn) as Array<{result_json:string}>;
    return records.flatMap(record=>{
      const value=JSON.parse(record.result_json),output=value.output ?? value;
      assert.ok(Array.isArray(output.steps),'journal stores the entire receipt array');
      return output.steps;
    });
  } finally {db.close()}
}

/** Every available tab retains its newest observation/result, including intermediate bodies. */
export function assertBrowserBodies(requests:StubModelRequest[]) {
  const first = new Map<string,string>();
  const finalStubs = new Map<string,string>();
  for(const request of requests.filter(request=>request.stream)) {
    assert.ok(!JSON.stringify(request.body).includes('image_url'));
    const calls=new Map<string,{name:string;arguments:{tab?:string;observation?:string;steps?:unknown[]}}>();
    const tabs=new Map<string,{observations:number;acts:number;fullObservations:number;fullActs:number}>();
    const newest = new Map<string,boolean>();
    const actsByObservation=new Map<string,number>(),stubs:Array<{obs:string;acted:string}>=[];
    for(const message of request.messages as any[]) {
      for(const call of message.tool_calls ?? []) {
        const arguments_=JSON.parse(call.function.arguments);
        calls.set(call.id,{name:call.function.name,arguments:call.function.name==='tool_call'?arguments_.arguments:arguments_});
      }
      if(message.role!=='tool')continue;
      const output=JSON.parse(message.content).output;
      assert.ok(!JSON.stringify(output).includes('still_file'));
      if(!['butler.browser-observation.v1','butler.browser-action.v1'].includes(output?.schema))continue;
      const tab=output.tab ?? calls.get(message.tool_call_id)?.arguments.tab;assert.ok(tab);
      const key=String(message.tool_call_id),content=String(message.content);
      const stub=output.status==='superseded' || output.superseded===true;
      newest.set(`${tab}:${output.schema}`, !stub);
      if(stub) {
        assert.equal(finalStubs.get(key) ?? content,content,'written stubs never change');
        finalStubs.set(key,content);
      } else {
        assert.ok(!finalStubs.has(key),'stubs never become full again');
        assert.equal(first.get(key) ?? content,content,'full output is byte-identical to first send');
        first.set(key,content);
      }
      const row=tabs.get(tab) ?? {observations:0,acts:0,fullObservations:0,fullActs:0};
      if(output.schema==='butler.browser-observation.v1') {
        row.observations++;if(output.status!=='superseded')row.fullObservations++;
        else stubs.push(output);
      } else {
        row.acts++;if(output.superseded!==true)row.fullActs++;
        const args=calls.get(message.tool_call_id)!.arguments;
        const completed=completedAct(output,args.steps?.length ?? 0);
        actsByObservation.set(args.observation!,completed+(actsByObservation.get(args.observation!) ?? 0));
      }
      tabs.set(tab,row);
    }
    for(const stub of stubs) {
      const acted=[...stub.acted.matchAll(/×(\d+) completed/gu)].reduce((sum,match)=>sum+Number(match[1]),0);
      assert.equal(acted,actsByObservation.get(stub.obs) ?? 0,'stub acted count stays consistent in every body');
    }
    assert.ok([...newest.values()].every(Boolean),'newest observation and action per tab stay full');
    for(const row of tabs.values()) {
      assert.ok(row.fullObservations >= (row.observations?1:0));
      assert.ok(row.fullActs >= (row.acts?1:0));
    }
  }
}

function completedAct(output:any,requested:number):number {
  if(Array.isArray(output.steps)) {
    assert.equal(output.steps.length,requested);
    assert.ok(output.steps.every((step:any)=>step.status==='completed'));
    return output.steps.length;
  }
  const summary=/^(\d+)\/(\d+) completed$/u.exec(output.steps);assert.ok(summary);
  assert.equal(Number(summary[2]),requested);
  assert.equal(Number(summary[1]),requested);
  return Number(summary[1]);
}
