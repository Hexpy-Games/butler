import { installIdentityHeaders } from "./identity-headers.mjs";
import { BrowserWindow, session } from "electron";

let nativeIdentity;
const HINTS = ["fullVersionList", "uaFullVersion", "platformVersion", "architecture", "bitness", "model", "wow64", "formFactors"];

// One offline secure-origin probe per process. It reads Chromium's own Client
// Hints values and languages, the ones every page reads from navigator.
async function readNativeIdentity() {
  const profile = session.fromPartition(`butler-identity-${crypto.randomUUID()}`, { cache: false });
  await profile.protocol.handle("https", () => new Response("<!doctype html><title>Identity</title>", { headers: { "content-type": "text/html" } }));
  const host = new BrowserWindow({ show: false, webPreferences: { session: profile, sandbox: true, nodeIntegration: false, contextIsolation: true } });
  try {
    await host.loadURL("https://browser-identity.invalid/");
    return await host.webContents.executeJavaScript(`navigator.userAgentData.getHighEntropyValues(${JSON.stringify(HINTS)})
      .then(data => ({ ...data, languages: navigator.languages }))`);
  } finally { host.destroy(); profile.protocol.unhandle("https"); }
}

/** A web profile keeps the process's User-Agent (bootstrap sets
 * app.userAgentFallback) and Chromium's own brands; no debugger is needed. Its
 * requests get the Client Hints Chrome sends and Electron omits, from the same
 * values pages read. Resolves once those values are known. */
export function configureWebSession(profile) {
  if (!nativeIdentity) {
    nativeIdentity = readNativeIdentity();
    void nativeIdentity.catch(() => {});
  }
  installIdentityHeaders(profile, nativeIdentity);
  // Accept-Language is the list pages read from navigator.languages: Electron's
  // App locale, then the system's preferred languages. It is the profile's
  // network setting, so it also covers views created before it was set.
  return nativeIdentity.then(native => profile.setUserAgent(profile.getUserAgent(), native.languages.join(",")));
}
