// No page API: only main can send source into this sandboxed, isolated world.
const {ipcRenderer,webFrame}=require('electron');
const nonce=Array.from(crypto.getRandomValues(new Uint32Array(4)),n=>n.toString(16)).join('-');
const name=`butler-browser-${nonce}`;
webFrame.setIsolatedWorldInfo(9001,{name});
void webFrame.executeJavaScriptInIsolatedWorld(9001,[{code:'void 0'}]).then(()=>{
  ipcRenderer.send('butler-browser-world:ready',name);
});
ipcRenderer.on('butler-browser-world:call',async(_event,id,code)=>{
  try {
    const value=await webFrame.executeJavaScriptInIsolatedWorld(9001,[{code}]);
    ipcRenderer.send('butler-browser-world:result',id,true,value);
  }catch{ipcRenderer.send('butler-browser-world:result',id,false,null)}
});
