// Narrow page controls only. No App API, credentials or arbitrary IPC reaches a page.
const { contextBridge, ipcRenderer } = require("electron");
const agent = process.argv.includes("--butler-agent-page");
contextBridge.exposeInMainWorld("__butlerPageControl", (type, message, value) => {
  if (type === "popup") return ipcRenderer.sendSync("butler-browser:page-control", { type, gesture: navigator.userActivation.isActive });
  if (!["alert", "confirm", "prompt", "beforeunload", "print", "file"].includes(type)) return null;
  return ipcRenderer.sendSync("butler-browser:page-control", { type, message: String(message ?? ""), value: String(value ?? "") });
});
// Ask synchronously before Chromium commits the original navigation, preserving
// form POST bodies and history entries. User pages never attach a debugger.
if (!agent) contextBridge.executeInMainWorld({ func: () => {
  const add = window.addEventListener, remove = window.removeEventListener, confirmUnload = window.confirm;
  const wrapped = new WeakMap(), answers = new WeakMap(), skipped = new WeakSet();
  let preparing = false, skipNext = false;
  const wrap = (handler, property = false) => function (event) {
    if (!preparing && skipNext) { skipNext = false; skipped.add(event); }
    if (skipped.has(event)) return;
    let requested = false, text = preparing ? "" : event.returnValue;
    const proxy = new Proxy(event, {
      get(target, key) {
        if (key === "preventDefault") return () => { requested = true; };
        if (key === "defaultPrevented") return requested || target.defaultPrevented;
        if (key === "returnValue") return text;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
      set(target, key, value) {
        if (key === "returnValue") { text = String(value); requested ||= text !== ""; return true; }
        return Reflect.set(target, key, value, target);
      },
    });
    const result = typeof handler === "function" ? handler.call(this, proxy) : handler.handleEvent(proxy);
    if (property && result != null) { text = String(result); requested = true; }
    if (!requested) return;
    if (!preparing) { event.preventDefault(); event.returnValue = text || " "; return text || " "; }
    if (!answers.has(event)) {
      window.__butlerPageControl("beforeunload", text);
      answers.set(event, confirmUnload.call(window, text));
    }
    if (!answers.get(event)) { event.preventDefault(); event.returnValue = text || " "; return text || " "; }
  };
  window.addEventListener = function (type, handler, options) {
    if (type === "beforeunload" && handler && (typeof handler === "function" || typeof handler === "object")) {
      if (!wrapped.has(handler)) wrapped.set(handler, wrap(handler));
      return add.call(this, type, wrapped.get(handler), options);
    }
    return add.call(this, type, handler, options);
  };
  window.removeEventListener = function (type, handler, options) {
    return remove.call(this, type, type === "beforeunload" ? wrapped.get(handler) ?? handler : handler, options);
  };
  const prepare = () => {
    preparing = true;
    const event = new Event("beforeunload", { cancelable: true });
    try { window.dispatchEvent(event); } finally { preparing = false; }
    skipNext = !event.defaultPrevented; return skipNext;
  };
  Object.defineProperty(window, "__butlerBeforeUnload", { configurable: false, value: prepare });
  document.addEventListener("submit", event => { if ((!event.target.target || event.target.target === "_self") && !prepare()) event.preventDefault(); }, true);
  document.addEventListener("click", event => {
    const link = event.composedPath().find(node => node instanceof HTMLAnchorElement);
    if (link && link.href.split("#")[0] !== location.href.split("#")[0] && (!link.target || link.target === "_self") && !event.ctrlKey && !event.metaKey && !event.shiftKey && !prepare()) event.preventDefault();
  }, true);
  const submit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function () { if (this.target && this.target !== "_self" || prepare()) submit.call(this); };
  let owner = window;
  while (owner && !Object.getOwnPropertyDescriptor(owner, "onbeforeunload")) owner = Object.getPrototypeOf(owner);
  const descriptor = owner && Object.getOwnPropertyDescriptor(owner, "onbeforeunload");
  if (descriptor?.set) {
    let handler = null;
    Object.defineProperty(window, "onbeforeunload", { configurable: false, get: () => handler, set(value) {
      handler = typeof value === "function" ? value : null;
      descriptor.set.call(window, handler ? wrap(handler, true) : null);
    } });
  }
} });
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

// A real HTML drag must enter/drop on the page's native view, not the presenter.
// Keep this private to the isolated preload; the page cannot invoke the IPC.
window.addEventListener("dragstart", event => {
  if (event.isTrusted) ipcRenderer.sendSync("butler-browser:page-drag", "start");
}, true);
window.addEventListener("dragend", event => {
  if (event.isTrusted) ipcRenderer.send("butler-browser:page-drag", "end");
}, true);
