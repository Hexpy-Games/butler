import {ipcMain} from 'electron';
import {randomUUID} from 'node:crypto';
const tabs=new Map(),pending=new Map();
ipcMain.on('butler-browser-world:ready',(event,name)=>{
  const tab=tabs.get(event.sender.id);
  if(tab && /^butler-browser-[0-9a-f-]+$/u.test(name)) {
    for(const [key,frame] of tab.nativeFrames)if(frame.isDestroyed() || frame.detached)tab.nativeFrames.delete(key);
    tab.nativeFrames.set(name,event.senderFrame);
  }
});
ipcMain.on('butler-browser-world:result',(event,id,ok,value)=>{
  const request=pending.get(id);
  if(!request || request.frame!==event.senderFrame || request.contentsId!==event.sender.id)return;
  clearTimeout(request.timer);pending.delete(id);
  if(ok)request.resolve(value);else request.reject(new Error('frame_unavailable'));
});
export function attachNativeWorlds(tab) {
  const contents=tab.view.webContents;
  tab.nativeFrames=new Map();tab.contextNames=new Map();tab.contextIds=new Map();tabs.set(contents.id,tab);
  contents.once('destroyed',()=>{
    tabs.delete(contents.id);
    for(const [id,request] of pending) if(request.contentsId===contents.id){clearTimeout(request.timer);pending.delete(id);request.reject(new Error('frame_unavailable'));}
  });
}
export function nativeFrameWorld(tab,frameId) {
  const frame=tab.nativeFrames.get(tab.contextNames.get(frameId));
  if(!frame || frame.isDestroyed())throw new Error('frame_unavailable');
  return {executeJavaScriptInIsolatedWorld:(_world,scripts)=>new Promise((resolve,reject)=>{
    const id=randomUUID(),timer=setTimeout(()=>{pending.delete(id);reject(new Error('frame_unavailable'))},5000);
    pending.set(id,{frame,contentsId:tab.view.webContents.id,timer,resolve,reject});
    try{frame.send('butler-browser-world:call',id,scripts[0].code)}catch(error){clearTimeout(timer);pending.delete(id);reject(error)}
  })};
}

export function noteNativeContext(tab,method,value,sessionId) {
  const prefix=`${sessionId || "root"}:`;
  if(method==="Runtime.executionContextCreated" && value.context.name.startsWith("butler-browser-")) {
    const context=value.context,frameId=context.auxData.frameId;
    tab.contextNames.set(frameId,context.name);tab.contextIds.set(`${prefix}${context.id}`,{frameId,name:context.name});
  }
  const remove=key=>{const context=tab.contextIds.get(key);if(context && tab.contextNames.get(context.frameId)===context.name)tab.contextNames.delete(context.frameId);tab.contextIds.delete(key)};
  if(method==="Runtime.executionContextDestroyed")remove(`${prefix}${value.executionContextId}`);
  if(method==="Runtime.executionContextsCleared")for(const key of tab.contextIds.keys())if(key.startsWith(prefix))remove(key);
}
