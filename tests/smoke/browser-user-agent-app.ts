// test-category: security
/** Isolated real App: offline identity proof, then one optional Google sign-in visit. */
import { googleSigninProbe } from "../support/browser-google-probe";
import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app";
import { assertBrowserIdentity, identityFixture } from "../support/browser-identity-fixture";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence);
const fixture = identityFixture();
const app = await browserAgentApp(evidence, () => null);
try {
  const internal = await app.page.expression<string>("navigator.userAgent");
  await app.call("open");
  const id = await app.call<string>("create", { url: fixture.url, profile: "signed_out" });
  const contents = `globalThis.browserAgentSubject.tabs.get(${JSON.stringify(id)}).view.webContents`;
  await waitBrowser(() => app.main<boolean>(`!${contents}.isLoading() && ${contents}.getURL() === ${JSON.stringify(fixture.url)}`), "offline page loaded");
  await waitBrowser(() => app.main<boolean>(`${contents}.executeJavaScript('Boolean(globalThis.reports?.worker && globalThis.reports?.iframe)')`), "complete offline identity");
  const reports = await app.main<any>(`${contents}.executeJavaScript('globalThis.reports')`);
  assertBrowserIdentity(reports, await app.main<string>("process.versions.chrome"), fixture.requests);
  assert.equal(await app.page.expression("navigator.userAgent"), internal);
  assert.match(internal, /Electron\//u);
  writeFileSync(join(evidence, "real-app-identity.json"), JSON.stringify({ internal, reports, requests: fixture.requests }, null, 2));
  await app.call("close", { id });
  if (process.env.BUTLER_UA_GOOGLE_CHECK === "1") {
    const ko = await app.page.expression<boolean>("document.documentElement.lang.startsWith('ko')");
    if (await app.page.expression("document.querySelector('[data-test-class=mac-window]').getAttribute('data-left-open') === 'false'")) await app.click(ko ? "사이드바 보기" : "Show sidebar");
    await app.click(ko ? "브라우저" : "Browser");
    // A my-tab in the signed-in web profile, as the owner opens Google sign-in.
    const google = await app.call<string>("create", { url: "https://accounts.google.com/signin" });
    const wc = `globalThis.browserAgentSubject.tabs.get(${JSON.stringify(google)}).view.webContents`;
    // The one lookup has a 25 s observation window; allow its inspector call to finish.
    const result = await app.main<any>(`(${googleSigninProbe.toString()})(${wc})`, 35_000);
    writeFileSync(join(evidence, "google-signin-result.json"), JSON.stringify(result, null, 2));
    await app.main(`${wc}.capturePage().then(image=>process.getBuiltinModule('fs').writeFileSync(${JSON.stringify(join(evidence, "google-signin-native.png"))},image.toPNG()))`);
    writeFileSync(join(evidence, "google-signin-app-renderer.png"), await app.page.screenshot());
    console.log(JSON.stringify({ google: result.outcome }));
    assert.equal(result.outcome, "account_not_found", `Google probe: ${result.outcome}`);
    await app.call("close", { id: google });
  }
  console.log(JSON.stringify({ ok: true, brands: reports.page.js.data.brands, googleChecked: process.env.BUTLER_UA_GOOGLE_CHECK === "1" }));
} finally { fixture.server.stop(true); await app.stop(); }
