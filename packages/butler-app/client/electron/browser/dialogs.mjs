import { randomUUID } from "node:crypto";

/** Dialog answers use a separate, Rust-approved dispatch; the triggering click is never replayed. */
export function wireDialogs(browser, tab) {
  const contents=tab.view.webContents;
  void contents.debugger.sendCommand("Page.enable").catch(()=>{});
  contents.debugger.on("message", (_event, method, value) => {
    if (method === "Page.javascriptDialogOpening") {
      tab.dialog={id:randomUUID(),epoch:tab.epoch,type:value.type,message:value.message};
      tab.waiting=true;browser.publish();
    }
    if (method === "Page.javascriptDialogClosed") {tab.dialog=null;tab.waiting=false;browser.publish();}
  });
}
export function pendingDialog(tab) {
  return {status:"dialog_pending",tab:tab.id,url:tab.url,epoch:tab.epoch,dialog:tab.dialog};
}
export async function answerDialog(browser, tab, args) {
  if (!tab.dialog || tab.dialog.id!==args.dialog || tab.dialog.epoch!==tab.epoch || args.accept!==true) return {status:"not_dispatched",reason:"stale_dialog"};
  if (tab.dialog.beforeUnloadClose) { browser.close(tab.id); return {status:"ok",tab:tab.id}; }
  await tab.view.webContents.debugger.sendCommand("Page.handleJavaScriptDialog",{accept:true});
  const steps=(tab.pendingBatch ?? []).map(step=>step.reason==="dialog_pending"?{...step,status:"completed",reason:undefined}:step);
  tab.pendingBatch=null;
  return {status:"ok",tab:tab.id,epoch:tab.epoch,url:tab.url,steps};
}

export function requestClose(browser, tab) {
  if (tab.dialog) return Promise.resolve(pendingDialog(tab));
  const contents=tab.view?.webContents;
  if (!contents || contents.isDestroyed()) {browser.close(tab.id);return Promise.resolve({status:"ok"});}
  return new Promise(resolve=>{
    let settled=false;
    const finish=result=>{
      if(settled) return;settled=true;clearTimeout(timer);
      contents.removeListener("will-prevent-unload",prevented);contents.removeListener("destroyed",closed);resolve(result);
    };
    const prevented=()=>{
      tab.dialog={id:randomUUID(),epoch:tab.epoch,type:"beforeunload",message:tab.title,beforeUnloadClose:true};
      tab.waiting=true;browser.publish();finish(pendingDialog(tab));
    };
    const closed=()=>{browser.close(tab.id);finish({status:"ok",tab:tab.id});};
    const timer=setTimeout(()=>finish({status:"unknown",reason:"close_interrupted"}),4500);
    contents.once("will-prevent-unload",prevented);contents.once("destroyed",closed);
    contents.close({waitForBeforeUnload:true});
  });
}
