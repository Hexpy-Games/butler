import { nativeFrameWorld } from "./native-worlds.mjs";
import { closedRoots } from "./closed-roots.mjs";

/** CDP frame IDs differ from Electron Blink frame tokens. Keep refs in owned worlds. */
export async function frameWorlds(tab) {
  await tab.debuggerReady;
  await Promise.all(tab.frameAttachPromises.values());
  const debuggerApi=tab.view.webContents.debugger;
  const command=(method,params,sessionId)=>debuggerApi.sendCommand(method,params,sessionId);
  const root=(await command("Page.getFrameTree")).frameTree;
  const frames=[], documents=new Map();
  async function visit(tree,parent) {
    const id=tree.frame.id, sessionId=tab.frameSessions?.get(id);
    const api={sendCommand:(method,params)=>command(method,params,sessionId)};
    if(!documents.has(sessionId)) documents.set(sessionId,await api.sendCommand("DOMSnapshot.captureSnapshot",{computedStyles:[]}));
    const mainId=sessionId?id:root.frame.id;
    let closed=await closedRoots(api,id,mainId,documents.get(sessionId),true);
    const native=closed.hasClosedRoots ? undefined : parent ? nativeFrameWorld(tab,id) : tab.view.webContents;
    if (!native && !closed.contextId) closed=await closedRoots(api,id,mainId,documents.get(sessionId));
    const contextId=closed.contextId;
    const url=/^about:(blank|srcdoc)$/u.test(tree.frame.url)?parent?.url:tree.frame.url;
    const webFrame=parent?tab.nativeFrames.get(tab.contextNames.get(id)):tab.view.webContents.mainFrame;
    const frame={id,url,parent,sessionId,api,contextId,native,webFrame};frames.push(frame);
    for(const child of tree.childFrames ?? []) await visit(child,frame);
  }
  await visit(root,null);
  const extra=[];
  for(const [id,session] of tab.frameSessions)if(!frames.some(frame=>frame.id===id)) {
    const {frameTree}=await command("Page.getFrameTree",{},session);extra.push(frameTree);
  }
  while(extra.length) {
    let progressed=false;
    for(const tree of [...extra]) {
      const native=tab.nativeFrames.get(tab.contextNames.get(tree.frame.id));
      const parent=frames.find(frame=>frame.id===tree.frame.parentId || native?.parent && frame.webFrame?.frameToken===native.parent.frameToken);
      if(parent) {await visit(tree,parent);extra.splice(extra.indexOf(tree),1);progressed=true;}
    }
    if(!progressed)throw new Error("frame_unavailable");
  }
  return frames;
}
export async function evaluateWorld(frame,code) {
  if(frame.native) return frame.native.executeJavaScriptInIsolatedWorld(9001,[{code}]);
  const result=await frame.api.sendCommand("Runtime.evaluate",{expression:code,contextId:frame.contextId,returnByValue:true,awaitPromise:true});
  if(result.exceptionDetails) throw new Error("frame_unavailable");
  return result.result.value;
}
export async function framePoint(frame,point) {
  if (!frame.parent) return point;
  const {backendNodeId}=await frame.parent.api.sendCommand("DOM.getFrameOwner",{frameId:frame.id});
  const {model}=await frame.parent.api.sendCommand("DOM.getBoxModel",{backendNodeId});
  // A box is relative to its CDP target's root viewport. OOPIF parents add their offset.
  const local={...point,x:point.x+model.content[0],y:point.y+model.content[1]};
  if(frame.parent.sessionId) return framePoint(frame.parent,local);
  return local;
}

/** Hit-test inside every renderer target and its embedding iframe. A frame whose
 * owner has no layout box (a hidden iframe) contains no point. */
export async function hitFrame(frame,local) {
  try { return await hitFrameChecked(frame,local); }
  catch (error) { if (/box model|frame_unavailable|No node/u.test(String(error?.message))) return null; throw error; }
}
async function hitFrameChecked(frame,local) {
  const point=await framePoint(frame,local);
  let current=frame, owner;
  while(current) {
    let root=current;
    while(root.parent && root.parent.sessionId===root.sessionId) root=root.parent;
    const origin=await framePoint(root,{x:0,y:0});
    const hit=await root.api.sendCommand("DOM.getNodeForLocation",{
      x:Math.round(point.x-origin.x),y:Math.round(point.y-origin.y),includeUserAgentShadowDOM:true,
    });
    // CDP stops at an OOPIF's embedding node; it cannot hit the remote document.
    if(owner ? hit.backendNodeId!==owner.backendNodeId : hit.frameId!==frame.id) return null;
    if(!root.parent) break;
    owner=await root.parent.api.sendCommand("DOM.getFrameOwner",{frameId:root.id});
    current=root.parent;
  }
  return point;
}
