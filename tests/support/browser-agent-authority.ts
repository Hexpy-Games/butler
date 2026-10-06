import { strict as assert } from "node:assert";
import type { browserAgentApp } from "./browser-agent-app";
import { waitBrowser } from "./browser-agent-app";
import { describeBrowser, bridgeBrowser, actConfirm, type browserStub } from "./browser-agent-stub";

type App = Awaited<ReturnType<typeof browserAgentApp>>;
type Request = { request_ref: string; approval: { operation: { allow_conversation: boolean; targets: string[] } } };
export async function browserAuthorityChecks(app: App, stub: ReturnType<typeof browserStub>, tab: string, send: (text: string) => Promise<void>, delivered: () => Promise<void>) {
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
  await act("Allow future acts on this site in this conversation.");
  const site = await pending(); assert.equal(site.approval.operation.allow_conversation,true);
  await allow(site.request_ref,"conversation"); await delivered();
  await act("Use the same site's conversation grant."); await delivered();
  assert.equal((await requests()).requests.length,0);
  const contents = `globalThis.browserAgentSubject.tabs.get(${JSON.stringify(tab)}).view.webContents`;
  await app.gateway.api("/settings",{method:"PATCH",body:JSON.stringify({access_mode:"full_access"})});
  await app.main(`${contents}.executeJavaScript("document.body.insertAdjacentHTML('beforeend','<input id=payment-field type=hidden autocomplete=cc-number>')")`);
  await act("Confirm the payment-like submit, even in full access.");
  const payment = await pending(); assert.equal(payment.approval.operation.allow_conversation,false);
  const response = await fetch(`${app.gateway.url}/authority-requests/${payment.request_ref}/allow?session_id=general`,{method:"POST",headers:{...app.gateway.authHeaders,"content-type":"application/json"},body:JSON.stringify({scope:"conversation"})});
  assert.equal(response.status,400); assert.match(await response.text(),/browser_confirm_once_required/u);
  await allow(payment.request_ref,"once"); await delivered();
  await app.main(`${contents}.executeJavaScript("document.getElementById('payment-field').remove();window.dialogClicks=0;document.getElementById('confirm').onclick=()=>{window.dialogClicks++;if(confirm('Continue?'))document.getElementById('result').textContent='Confirmed'}")`);
  await act("Ask before answering the page's confirmation dialog.");
  const dialog = await pending(); assert.equal(dialog.approval.operation.allow_conversation,false);
  assert.ok(dialog.approval.operation.targets.some(target=>target.includes("Continue?")));
  await allow(dialog.request_ref,"once"); await delivered();
  assert.equal(await app.main(`${contents}.executeJavaScript('window.dialogClicks')`),1,"dialog continuation never replays its click");
}
