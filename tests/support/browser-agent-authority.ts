import {Database} from "bun:sqlite";
import { strict as assert } from "node:assert";
import {writeFileSync} from "node:fs";
import {join} from "node:path";
import type { browserAgentApp } from "./browser-agent-app";
import { waitBrowser } from "./browser-agent-app";
import { describeBrowser, bridgeBrowser, actConfirm, type browserStub } from "./browser-agent-stub";

type App = Awaited<ReturnType<typeof browserAgentApp>>;
type Request = { request_ref: string; approval: { operation: { allow_conversation: boolean; targets: string[] } } };
export async function browserAuthorityChecks(app: App, stub: ReturnType<typeof browserStub>, tab: string, send: (text: string) => Promise<void>, delivered: () => Promise<void>, evidence:string) {
  const requests = () => app.gateway.api<{requests: Request[]}>("/authority-requests?session_id=general");
  const act = async (text: string) => {
    stub.set([describeBrowser, () => bridgeBrowser("browser_observe", {tab}), actConfirm]);
    await send(text);
  };
  const pending = async () => {
    await waitBrowser(async () => (await requests()).requests.length === 1, "one durable browser approval");
    return (await requests()).requests[0]!;
  };
  const allow = (reference: string, scope: string) => app.gateway.api(`/authority-requests/${reference}/allow?session_id=general`, {method:"POST",body:JSON.stringify({scope})});
  const contents = `globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab)}).view.webContents`;
  await app.gateway.api("/settings",{method:"PATCH",body:JSON.stringify({access_mode:"ask_except_reads"})});
  await act("Refuse a changed target after approval.");
  const changed=await pending();
  await app.main(`${contents}.executeJavaScript("window.changedApprovalClicks=0;window.originalApprovalClick=document.getElementById('confirm').onclick;document.getElementById('confirm').onclick=function(e){window.changedApprovalClicks++;return originalApprovalClick?.call(this,e)};document.getElementById('confirm').textContent='Changed target';void 0")`);
  await allow(changed.request_ref,'once');await delivered();
  const identity=await app.call<{tabs:Array<{id:string;waiting:boolean}>}>('state');
  assert.equal(identity.tabs.find(t=>t.id===tab)!.waiting,false,'a refused approval identity is no longer waiting');
  assert.equal(await app.main(`${contents}.executeJavaScript('window.changedApprovalClicks')`),0,'changed approval never dispatches');
  assert.ok(JSON.stringify(stub.results).includes('authority_request_identity_mismatch'));
  const mismatch=findMismatch(stub.results);
  assert.equal(mismatch?.status,'unknown');assert.equal(mismatch?.observe_required,true);
  assert.equal(mismatch?.steps.length,1);assert.equal(mismatch?.steps[0].status,'unknown');
  const db=new Database(join(app.gateway.butlerData,'agent-runtime/btcc.sqlite'),{readonly:true});
  const record=db.query('SELECT decision,outcome,close_reason FROM btcc_authority_requests WHERE request_ref=?1').get(changed.request_ref) as {outcome:string};db.close();
  assert.equal(record.outcome,'uncertain','interrupted approval remains durably uncertain');
  writeFileSync(join(evidence,'changed-approval-identity.json'),JSON.stringify({request:changed.request_ref,waiting:false,dispatched:0,error:'authority_request_identity_mismatch',record}));
  await app.main(`${contents}.executeJavaScript("document.getElementById('confirm').textContent='Confirm';document.getElementById('confirm').onclick=originalApprovalClick;delete window.originalApprovalClick;void 0")`);
  await act("Allow future acts on this site in this conversation.");
  const site = await pending(); assert.equal(site.approval.operation.allow_conversation,true);
  await allow(site.request_ref,"conversation"); await delivered();
  await act("Use the same site's conversation grant."); await delivered();
  assert.equal((await requests()).requests.length,0);
  await app.gateway.api("/settings",{method:"PATCH",body:JSON.stringify({access_mode:"full_access"})});
  await app.main(`${contents}.executeJavaScript("document.body.insertAdjacentHTML('beforeend','<input id=payment-field type=hidden autocomplete=cc-number>')")`);
  await act("Confirm the payment-like submit, even in full access.");
  const payment = await pending(); assert.equal(payment.approval.operation.allow_conversation,false);
  const response = await fetch(`${app.gateway.url}/authority-requests/${payment.request_ref}/allow?session_id=general`,{method:"POST",headers:{...app.gateway.authHeaders,"content-type":"application/json"},body:JSON.stringify({scope:"conversation"})});
  assert.equal(response.status,400); assert.match(await response.text(),/browser_confirm_once_required/u);
  await allow(payment.request_ref,"once"); await delivered();
  await app.main(`${contents}.executeJavaScript("document.getElementById('payment-field').remove();window.dialogClicks=0;document.getElementById('confirm').onclick=()=>{window.dialogClicks++;if(confirm('Continue?'))document.getElementById('result').textContent='Confirmed'};void 0")`);
  await act("Ask before answering the page's confirmation dialog.");
  const dialog = await pending(); assert.equal(dialog.approval.operation.allow_conversation,false);
  assert.ok(dialog.approval.operation.targets.some(target=>target.includes("Continue?")));
  await allow(dialog.request_ref,"once"); await delivered();
  assert.equal(await app.main(`${contents}.executeJavaScript('window.dialogClicks')`),1,"dialog continuation never replays its click");
}

function findMismatch(value:unknown):any {
  if(typeof value==='string'){try{return findMismatch(JSON.parse(value))}catch{return undefined}}
  if(!value || typeof value!=='object')return undefined;
  if((value as {error?:string}).error==='authority_request_identity_mismatch')return value;
  for(const item of Object.values(value)){const found=findMismatch(item);if(found)return found}
}
