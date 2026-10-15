import { installIdentityHeaders } from "./identity-headers.mjs";
import { app, BrowserWindow, session } from "electron";
import { chromeIdentity, chromeUserAgent } from "../butler-platform/browser-identity.mjs";

const installed = new WeakMap();
let nativeIdentity;
const HINTS = ["platformVersion", "architecture", "bitness", "model", "wow64"];

// One offline secure-origin probe per process. It uses Chromium's own platform
// metadata, including Windows' API-contract version and translated CPU facts.
async function readNativeIdentity() {
  const profile = session.fromPartition(`butler-identity-${crypto.randomUUID()}`, { cache: false });
  await profile.protocol.handle("https", () => new Response("<!doctype html><title>Identity</title>", { headers: { "content-type": "text/html" } }));
  const host = new BrowserWindow({ show: false, webPreferences: { session: profile, sandbox: true, nodeIntegration: false, contextIsolation: true } });
  try {
    await host.loadURL("https://browser-identity.invalid/");
    return await host.webContents.executeJavaScript(`navigator.userAgentData.getHighEntropyValues(${JSON.stringify(HINTS)})`);
  } finally { host.destroy(); profile.protocol.unhandle("https"); }
}

/** Only web-content callers enroll; the App and its internal shells stay native. */
export function configureWebIdentity(contents, initialize = true) {
  if (installed.has(contents)) return installed.get(contents);
  const fullVersion = process.versions.chrome;
  const userAgent = contents.getUserAgent();
  const acceptLanguage = app.getPreferredSystemLanguages().join(",") || app.getLocale();
  // Set the native network/worker default synchronously, before popup navigation.
  const ua = chromeUserAgent(userAgent, fullVersion, app.getVersion());
  contents.session.setUserAgent(ua, acceptLanguage);
  // Electron 44 session UA overrides leave native brands Chromium-only. CDP
  // remains necessary for Butler brands in documents and out-of-process workers.
  if (initialize && !contents.debugger.isAttached()) contents.debugger.attach("1.3");
  const identity = (nativeIdentity ??= readNativeIdentity()).then(native => chromeIdentity(userAgent, fullVersion, native, acceptLanguage, app.getVersion()));
  installIdentityHeaders(contents.session, identity);
  const send = (method, params, id) => contents.debugger.sendCommand(method, params, id);
  const apply = async (id, type = "page") => {
    await send(type.includes("worker") ? "Network.setUserAgentOverride" : "Emulation.setUserAgentOverride", await identity, id);
    await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, id);
  };
  contents.debugger.on("message", (_event, method, params) => {
    if (method !== "Target.attachedToTarget") return;
    const id = params.sessionId;
    void apply(id, params.targetInfo.type).then(() => send("Runtime.runIfWaitingForDebugger", {}, id)).catch(() => {
      // A target that cannot establish its identity must not navigate with the
      // embedded-browser identity. Closing also releases any paused worker.
      void send("Target.closeTarget", { targetId: params.targetInfo.targetId }).catch(() => {});
    });
  });
  const ready = (async () => {
    // A new native view has no renderer until its first load. Initialize a
    // local blank document before sending renderer-scoped CDP commands.
    if (initialize && !contents.getURL()) await contents.loadURL("about:blank");
    else await new Promise(resolve => setImmediate(resolve));
    if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
    await apply();
  })(); installed.set(contents, ready);
  void ready.catch(() => { if (!contents.isDestroyed()) contents.stop(); });
  return ready;
}
