// test-category: security
/** Session event -> owner DS chooser -> exactly one native callback, stub accounts. */
import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { browserAgentApp, waitBrowser } from "../support/browser-agent-app";
import { identityFixture } from "../support/browser-identity-fixture";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence);
const fixture = identityFixture();
const url = fixture.url.replace("127.0.0.1", "localhost");
const app = await browserAgentApp(evidence, () => null);
try {
  await app.call("open");
  const id = await app.call<string>("create", { url });
  const tab = `globalThis.browserAgentSubject.tabs.get(${JSON.stringify(id)})`;
  const wc = `${tab}.view.webContents`;
  await waitBrowser(() => app.main(`${wc}.getURL() === ${JSON.stringify(url)} && !${wc}.isLoading()`), "passkey fixture loaded");
  const emit = async () => {
    await app.main(`(()=>{globalThis.passkeyAnswers=[];${wc}.session.emit('select-webauthn-account',{},
      {relyingPartyId:'localhost',frame:${wc}.mainFrame,accounts:[{name:'first@example.test',displayName:'First account',credentialId:'credential-first'},
      {name:'second@example.test',displayName:'Second account',credentialId:'credential-second'}]},value=>globalThis.passkeyAnswers.push(value??null));})()`);
    await app.page.waitForFunction(() => Boolean(document.querySelector('[data-test-class=browser-page-dialog]')));
    assert.doesNotMatch(JSON.stringify(await app.call("state")), /credential-first|credential-second/u);
  };
  for (const language of ["en", "ko"]) for (const theme of ["light", "dark"]) for (const width of [1440, 390]) {
    await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language, appearance_theme: theme }) });
    await app.main(`${app.win}.setMinimumSize(320,320);${app.win}.setContentSize(${width},900)`);
    await app.page.reload();
    await app.page.waitForFunction(() => Boolean(document.querySelector('[data-test-class=mac-window]')));
    // Navigate through the existing app command so mobile and desktop use the same public view.
    if (!await app.page.expression("Boolean(document.querySelector('[data-test-class=browser-area]'))")) {
      if (await app.page.expression("document.querySelector('[data-test-class=mac-window]')?.getAttribute('data-left-open') === 'false'")) await app.click(language === "ko" ? "사이드바 보기" : "Show sidebar");
      await app.click(language === "ko" ? "브라우저" : "Browser");
    }
    if (width === 390 && await app.page.expression("document.querySelector('[data-test-class=mac-window]')?.getAttribute('data-left-open') === 'true'")) {
      const label = language === "ko" ? "사이드바 숨기기" : "Hide sidebar";
      const point = await app.page.expression<{ x: number; y: number }>(`(()=>{const n=[...document.querySelectorAll('button')].find(n=>n.getAttribute('aria-label')===${JSON.stringify(label)} && n.getBoundingClientRect().width<100);const r=n.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await app.page.pointerDown(point.x, point.y); await app.page.pointerUp(point.x, point.y);
      await app.page.waitForFunction(() => document.querySelector('[data-test-class=mac-window]')?.getAttribute('data-left-open') === 'false');
    }
    await app.call("activate", { id });
    const name = `${language}-${theme}-${width}`;
    writeFileSync(join(evidence, `${name}-before.png`), await app.page.screenshot());
    await emit();
    const label = language === "ko" ? "패스키 선택" : "Choose passkey";
    assert.equal(await app.page.expression("document.querySelector('[data-test-class=browser-page-dialog] h2')?.textContent"), label);
    assert.equal(await app.page.expression("[...document.querySelectorAll('[data-test-class=browser-page-dialog] button')].find(b=>b.textContent==='OK'||b.textContent==='확인')?.disabled"), true);
    writeFileSync(join(evidence, `${name}-chooser.png`), await app.page.screenshot());
    await app.page.clickSelector('[data-test-class=browser-page-dialog] [role=combobox]');
    await app.page.waitForFunction(() => Boolean(document.querySelector('[role=option]')));
    writeFileSync(join(evidence, `${name}-options.png`), await app.page.screenshot());
    await app.page.clickText("Second account", '[role=option]');
    writeFileSync(join(evidence, `${name}-after.png`), await app.page.screenshot());
    await app.click(language === "ko" ? "확인" : "OK");
    await waitBrowser(() => app.main(`!${tab}.dialog`), "passkey answered");
    assert.deepEqual(await app.main("globalThis.passkeyAnswers"), ["credential-second"]);
  }
  await emit();
  await app.click("취소");
  assert.deepEqual(await app.main("globalThis.passkeyAnswers"), [null]);
  await emit();
  await app.main(`${wc}.reload()`);
  await waitBrowser(() => app.main(`!${tab}.dialog`), "passkey cancelled on navigation");
  assert.deepEqual(await app.main("globalThis.passkeyAnswers"), [null]);
  await waitBrowser(() => app.main(`!${wc}.isLoading()`), "reloaded fixture");
  await app.main(`${wc}.executeJavaScript("globalThis.webauthnProbe={available:'pending',observed:'pending'};PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().then(v=>webauthnProbe.available=v,e=>webauthnProbe.available=e.name);globalThis.webauthnAbort=new AbortController();navigator.credentials.get({signal:webauthnAbort.signal,publicKey:{challenge:crypto.getRandomValues(new Uint8Array(32)),timeout:1000}}).then(()=>webauthnProbe.observed='resolved',e=>webauthnProbe.observed=e.name);true")`);
  await new Promise(done => setTimeout(done, 2500));
  const platform = await app.main(`${wc}.executeJavaScript("({...webauthnProbe})")`);
  await app.main(`${wc}.executeJavaScript("webauthnAbort.abort();true")`);
  writeFileSync(join(evidence, "platform-webauthn.json"), JSON.stringify(platform, null, 2));
  await emit();
  await app.main(`globalThis.browserAgentSubject.close(${JSON.stringify(id)})`);
  assert.deepEqual(await app.main("globalThis.passkeyAnswers"), [null]);
  console.log(JSON.stringify({ ok: true, chooserCases: 8, platform }));
} catch (error) {
  writeFileSync(join(evidence, "failure.png"), await app.page.screenshot());
  writeFileSync(join(evidence, "failure-dom.json"), JSON.stringify(await app.page.expression("[...document.querySelectorAll('button,[role=option]')].map(e=>({text:e.textContent,role:e.getAttribute('role'),rect:e.getBoundingClientRect().toJSON()}))"), null, 2));
  throw error;
} finally { fixture.server.stop(true); await app.stop(); }
