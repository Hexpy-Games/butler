/** The real standalone hub starts and replaces its last tab with a library DOM page. */
import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { browserAgentApp, waitBrowser } from "./browser-agent-app";
import type { ElectronPage } from "./electron-page-cdp";
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
    await assertNewTabContent(app.page, locale);
    assert.equal(await app.page.expression("getComputedStyle(document.querySelector('[data-slot=browser-pane]')).outlineStyle"), "none");
    assert.equal(await app.page.expression("document.querySelector('[data-slot=page-card]').getAttribute('data-holder')"), "none");
    await newTabShot(app, `${locale}-${theme}-1440-newtab`);
    await app.click(locale === "ko" ? "탭 닫기" : "Close tab");
    await waitBrowser(async () => {
      const state = await app.call<{ tabs: Array<{ id: string; url: string }> }>("state");
      return state.tabs.length === 1 && state.tabs[0]!.id !== before.tabs[0]!.id && state.tabs[0]!.url === "";
    }, "last tab replaced once");
    await waitBrowser(() => app.page.expression("document.activeElement?.closest('[data-slot=address-field]') !== null"), "replacement address focus");
    await assertNewTabContent(app.page, locale);
    await newTabShot(app, `${locale}-${theme}-1440-last-tab-closed`);
  }
  await populatedNewTab(app.page, app.gateway, () => newTabShot(app, "en-dark-newtab-populated"));
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

/** Inspect the page content, excluding toolbar bookmark buttons and overlays. */
export async function assertNewTabContent(page: ElectronPage, locale: string, populated = false) {
  const ko = locale === "ko";
  const expected = [
    { title: ko ? "북마크" : "Bookmarks", cards: populated ? ["Loose bookmark", "Work bookmark"] : [],
      folders: populated ? ["Work"] : [], empty: populated ? 0 : 1, viewAll: [], grids: populated ? [1, 1] : [] },
    { title: ko ? "최근 스크랩" : "Recent scraps", cards: populated ? ["Scrap 4", "Scrap 3", "Scrap 2"] : [],
      folders: [], empty: populated ? 0 : 1, viewAll: [ko ? "모두 보기" : "View all"], grids: [populated ? 3 : 0] },
  ];
  const read = () => page.expression<typeof expected>(`(() => {
    const content = document.querySelector('[data-slot=page-card-content]');
    return [...(content?.querySelectorAll('section') ?? [])].map(section => ({
      title: section.querySelector('h3')?.textContent,
      cards: [...section.querySelectorAll('[data-library-card] [data-slot=clickable][aria-label]')]
        .map(node => node.getAttribute('aria-label')),
      folders: [...section.querySelectorAll('[data-test-class=bookmark-folder]')].map(node => node.textContent),
      empty: [...section.querySelectorAll('p')].filter(node => node.textContent === ${JSON.stringify(ko ? "항목 없음" : "No items")}).length,
      viewAll: [...section.querySelectorAll('button')].filter(node => node.textContent === ${JSON.stringify(ko ? "모두 보기" : "View all")}).map(node => node.textContent),
      grids: [...section.querySelectorAll('[data-columns]')].map(node => node.querySelectorAll('[data-library-card]').length),
    }));
  })()`);
  await waitBrowser(async () => JSON.stringify(await read()) === JSON.stringify(expected), "new-tab library sections loaded completely");
  assert.deepEqual(await read(), expected, "new tab has bookmark/folder grids, recent scraps and per-section empty states");
  assert.equal(await page.expression("!document.querySelector('[data-slot=native-view-slot]:not([data-hidden=true])')"), true, "new tab stays in the DOM rather than displaying a native document");
}

/** Seed through the real Library API, then restore the empty isolated library. */
export async function populatedNewTab(page: ElectronPage, gateway: Awaited<ReturnType<typeof browserAgentApp>>["gateway"], shot: () => Promise<void>) {
  const crop = await page.expression<string>("(() => {const canvas=document.createElement('canvas');canvas.width=16;canvas.height=16;canvas.getContext('2d').fillRect(0,0,16,16);return canvas.toDataURL('image/jpeg')})()");
  const savedIds: string[] = [];
  const items = [
    { id: "smoke-work", kind: "bookmark", title: "Work bookmark", folder: "Work", capturedAt: "2026-01-01T00:00:00Z" },
    { id: "smoke-loose", kind: "bookmark", title: "Loose bookmark", capturedAt: "2026-01-02T00:00:00Z" },
    ...[1, 2, 3, 4].map(index => ({ id: `smoke-scrap-${index}`, kind: "scrap", title: `Scrap ${index}`, text: `Saved scrap ${index}`, crop, capturedAt: `2026-01-0${index}T00:00:00Z` })),
  ];
  try {
    for (const item of items) {
      const saved = await gateway.api<{ id: string }>("/library", { method: "POST", body: JSON.stringify({ ...item, url: `https://example.com/${item.id}`, site: "example.com" }) });
      savedIds.push(saved.id);
    }
    await reloadNewTab(page);
    await assertNewTabContent(page, "en", true);
    await shot();
  } finally {
    for (const id of savedIds) await gateway.api(`/library/${id}`, { method: "DELETE" });
  }
  await reloadNewTab(page);
  await assertNewTabContent(page, "en");
}

async function reloadNewTab(page: ElectronPage) {
  await page.reload();
  await page.waitForFunction(() => Boolean(document.querySelector('[data-test-class="browser-entry"]')));
  await page.clickSelector('[data-test-class="browser-entry"]');
}
