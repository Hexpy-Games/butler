// Narrow page controls only. No App API, credentials or arbitrary IPC reaches a page.
const { contextBridge, ipcRenderer } = require("electron");
const agent = process.argv.includes("--butler-agent-page");
contextBridge.exposeInMainWorld("__butlerPageControl", (type, message, value) => {
  if (type === "popup") return ipcRenderer.sendSync("butler-browser:page-control", { type, gesture: navigator.userActivation.isActive });
  if (!["alert", "confirm", "prompt", "print", "file"].includes(type)) return null;
  return ipcRenderer.sendSync("butler-browser:page-control", { type, message: String(message ?? ""), value: String(value ?? "") });
});
contextBridge.executeInMainWorld({ func: (isAgent) => {
  const open = window.open;
  window.open = function (...args) { window.__butlerPageControl("popup"); return open.apply(this, args); };
  // Electron throws before CDP can report native prompt(); use the same narrow
  // bridge for that one dialog. Agent alert/confirm/beforeunload remain CDP-owned.
  for (const type of isAgent ? ["prompt"] : ["alert", "confirm", "prompt"]) {
    Object.defineProperty(window, type, { configurable: false, value: (message, value) => window.__butlerPageControl(type, message, value) });
  }
  const choose = input => {
    const answer = window.__butlerPageControl("file", input.accept, input.multiple ? "multiple" : "single");
    if (!answer) return;
    const transfer = new DataTransfer();
    for (const item of answer) {
      const bytes = Uint8Array.from(atob(item.data), char => char.charCodeAt(0));
      transfer.items.add(new File([bytes], item.name, { type: item.type }));
    }
    input.files = transfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  document.addEventListener("click", event => {
    const input = event.composedPath().find(node => node instanceof HTMLInputElement && node.type === "file");
    if (input) { event.preventDefault(); choose(input); }
  }, true);
  const showPicker = HTMLInputElement.prototype.showPicker;
  HTMLInputElement.prototype.showPicker = function () { if (this.type === "file") choose(this); else showPicker.call(this); };
  Object.defineProperty(window, "print", { configurable: false, value: () => { window.__butlerPageControl("print"); } });
}, args: [agent] });
// No page API: only main can send source into this sandboxed, isolated world.
const { webFrame }=require("electron");
const nonce=Array.from(crypto.getRandomValues(new Uint32Array(4)), n=>n.toString(16)).join("-");
const name=`butler-browser-${nonce}`;
webFrame.setIsolatedWorldInfo(9001, { name });
void webFrame.executeJavaScriptInIsolatedWorld(9001, [{ code:"void 0" }]).then(()=>{
  ipcRenderer.send("butler-browser-world:ready", name);
});
ipcRenderer.on("butler-browser-world:call", async(_event, id, code)=>{
  try {
    const value=await webFrame.executeJavaScriptInIsolatedWorld(9001, [{ code }]);
    ipcRenderer.send("butler-browser-world:result", id, true, value);
  }catch{ipcRenderer.send("butler-browser-world:result", id, false, null);}
});
