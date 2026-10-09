/** Persistent main-process inspector; no diagnostic product IPC. */
export async function connectElectronMain(inspectorPort: number) {
  const targets = await fetch(`http://127.0.0.1:${inspectorPort}/json/list`).then(r => r.json());
  const socket = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise<void>((done, fail) => {
    socket.addEventListener("open", () => done(), { once: true });
    socket.addEventListener("error", () => fail(new Error("Main inspector connection failed")), { once: true });
  });
  let id = 0;
  const pending = new Map<number, {done:(value:any)=>void;fail:(error:Error)=>void}>();
  const close = () => {
    for (const entry of pending.values()) entry.fail(new Error("Main inspector disconnected"));
    pending.clear(); socket.close();
  };
  socket.addEventListener("close", close, {once:true});
  socket.addEventListener("error", close, {once:true});
  socket.addEventListener("message", event => {
    const reply=JSON.parse(String(event.data)),entry=pending.get(reply.id);
    if(!entry)return;
    pending.delete(reply.id);
    if(reply.error || reply.result?.exceptionDetails)entry.fail(new Error(JSON.stringify(reply)));
    else entry.done(reply.result);
  });
  const send = (method: string, params: Record<string, unknown>) => new Promise<any>((done, fail) => {
    if(socket.readyState!==WebSocket.OPEN){fail(new Error("Main inspector disconnected"));return}
    const requestId=++id;
    const timer=setTimeout(()=>{
      pending.delete(requestId);
      fail(new Error(`Main inspector timed out: ${method} request ${requestId}, socket ${socket.readyState}`));
    },10_000);
    pending.set(requestId,{done:value=>{clearTimeout(timer);done(value)},fail:error=>{clearTimeout(timer);fail(error)}});
    socket.send(JSON.stringify({id:requestId,method,params}));
  });
  return {
    async evaluate<T>(expression:string,queryInstances=false):Promise<T> {
      // Release remote handles from queryObjects after every query. Ordinary
      // evaluations return by value and allocate no retained inspector handles.
      const objectGroup=`butler-smoke-${id+1}`;
      try {
        const result=await send("Runtime.evaluate",{expression,awaitPromise:true,returnByValue:!queryInstances,objectGroup});
        if(!queryInstances)return result.result.value;
        const objects=await send("Runtime.queryObjects",{prototypeObjectId:result.result.objectId,objectGroup});
        const bounds=await send("Runtime.callFunctionOn",{objectId:objects.objects.objectId,
          functionDeclaration:"function(){return this.flatMap(t=>{try{return t.isDestroyed()?[]:[t.getBounds()]}catch(e){if(e.message.startsWith('Illegal invocation:'))return [];throw e}})}",returnByValue:true});
        return bounds.result.value;
      }finally{if(queryInstances)await send("Runtime.releaseObjectGroup",{objectGroup})}
    },
    close,
  };
}

/** One-shot callers still release the connection; long smokes reuse a client. */
export async function electronMain<T>(inspectorPort:number,expression:string,queryInstances=false):Promise<T> {
  const client=await connectElectronMain(inspectorPort);
  try{return await client.evaluate<T>(expression,queryInstances)}finally{client.close()}
}
