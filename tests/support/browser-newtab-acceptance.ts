/** The real standalone hub starts and replaces its last tab with a quiet DOM page. */
import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { browserAgentApp, waitBrowser } from "./browser-agent-app";
import { shellReady } from "./browser-shell-acceptance";

export async function newTabHub(app: Awaited<ReturnType<typeof browserAgentApp>>) {
  for (const locale of ["ko", "en"]) for (const theme of ["light", "dark"]) {
    await app.gateway.api("/settings", { method: "PATCH", body: JSON.stringify({ language: locale, appearance_theme: theme }) });
    await app.page.reload(); await shellReady(app, locale);
    await app.click(locale === "ko" ? "브라우저" : "Browser");
    // Re-entry with an existing blank tab also focuses the address.
    await waitBrowser(() => app.page.expression("document.activeElement?.closest('[data-slot=address-field]') !== null"), "new-tab address focus");
    const before = await app.call<{ tabs: Array<{ id: string; url: string }> }>("state");
    assert.equal(before.tabs.length, 1); assert.equal(before.tabs[0]!.url, "");
    assert.equal(await app.page.expression("document.querySelector('[data-slot=page-card-content]').textContent"), "");
    assert.equal(await app.page.expression("getComputedStyle(document.querySelector('[data-slot=browser-pane]')).outlineStyle"), "none");
    assert.equal(await app.page.expression("document.querySelector('[data-slot=page-card]').getAttribute('data-holder')"), "none");
    await newTabShot(app, `${locale}-${theme}-1440-newtab`);
    await app.click(locale === "ko" ? "탭 닫기" : "Close tab");
    await waitBrowser(async () => {
      const state = await app.call<{ tabs: Array<{ id: string; url: string }> }>("state");
      return state.tabs.length === 1 && state.tabs[0]!.id !== before.tabs[0]!.id && state.tabs[0]!.url === "";
    }, "last tab replaced once");
    await waitBrowser(() => app.page.expression("document.activeElement?.closest('[data-slot=address-field]') !== null"), "replacement address focus");
    await newTabShot(app, `${locale}-${theme}-1440-last-tab-closed`);
  }
}

async function newTabShot(app: Awaited<ReturnType<typeof browserAgentApp>>, name: string) {
  // A DOM new-tab page has no loaded native document whose animation frame we can await.
  const evidence = process.env.BUTLER_BROWSER_EVIDENCE; assert.ok(evidence);
  const capture = process.env.BUTLER_WINDOW_CAPTURE_EXECUTABLE; assert.ok(capture);
  await app.page.movePointer(900, 24);
  const source = await app.main<string>(`(() => {
    process.getBuiltinModule('module').createRequire(process.cwd() + '/packages/butler-app/client/electron/package.json')('electron').app.focus({steal:true});
    ${app.win}.show(); ${app.win}.focus(); ${app.win}.moveTop();
    return ${app.win}.getMediaSourceId();
  })()`);
  await app.page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  writeFileSync(join(evidence, `${name}-renderer.png`), await app.page.screenshot());
  const result = Bun.spawnSync([capture, source.split(":")[1]!, join(evidence, `${name}.png`)]);
  assert.equal(result.exitCode, 0, result.stderr.toString());
}
