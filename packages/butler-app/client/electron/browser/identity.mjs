import { installIdentityHeaders } from "./identity-headers.mjs";
import { BrowserWindow, session } from "electron";

let nativeIdentity;
const HINTS = ["fullVersionList", "uaFullVersion", "platformVersion", "architecture", "bitness", "model", "wow64", "formFactors"];

// One offline secure-origin probe per process. It reads Chromium's own Client
// Hints values, the ones every page reads from navigator.userAgentData.
async function readNativeIdentity() {
  const profile = session.fromPartition(`butler-identity-${crypto.randomUUID()}`, { cache: false });
  await profile.protocol.handle("https", () => new Response("<!doctype html><title>Identity</title>", { headers: { "content-type": "text/html" } }));
  const host = new BrowserWindow({ show: false, webPreferences: { session: profile, sandbox: true, nodeIntegration: false, contextIsolation: true } });
  try {
    await host.loadURL("https://browser-identity.invalid/");
    return await host.webContents.executeJavaScript(`navigator.userAgentData.getHighEntropyValues(${JSON.stringify(HINTS)})`);
  } finally { host.destroy(); profile.protocol.unhandle("https"); }
}

/** A web profile keeps the process's plain Chromium User-Agent (bootstrap sets
 * app.userAgentFallback) and Chromium's own brands; no debugger is needed. Its
 * requests get the Client Hints Chrome sends and Electron omits, from the same
 * values pages read. Resolves once those values are known. */
export function configureWebSession(profile) {
  if (!nativeIdentity) {
    nativeIdentity = readNativeIdentity();
    void nativeIdentity.catch(() => {});
  }
  installIdentityHeaders(profile, nativeIdentity);
  return nativeIdentity;
}
