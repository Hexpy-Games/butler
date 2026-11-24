import { getAppCopy } from "../../packages/butler-i18n/src/index.ts";
/** Offline real-App download and SelectionBar acceptance. No live model calls. */
import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { redesignApp } from "../support/browser-redesign-app";
import { waitBrowser } from "../support/browser-agent-app";
import { nativeAligned, shellReady } from "../support/browser-shell-acceptance";

const evidence = process.env.BUTLER_BROWSER_EVIDENCE!; assert.ok(evidence);
mkdirSync(evidence, { recursive: true });
const app = await redesignApp(evidence, { uiRoot: process.env.BUTLER_SMOKE_RENDERER_DIST });
const subject = (id: string) => `globalThis.browserAgentSubject.tabs.get(${JSON.stringify(id)})`;
const overlay = "globalThis.browserAgentSubject.pointer.view.webContents";
let tab = "";
async function pick(selector: string) {
  await waitBrowser(() => app.main("Boolean(globalThis.browserAgentSubject.pointer.ready)"), "pick overlay loaded");
  const point = await app.main<{ x: number; y: number }>(`${subject(tab)}.view.webContents.executeJavaScript(${JSON.stringify(`(()=>{const r=document.querySelector('${selector}').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)})`);
  const scale = await app.main<number>(`${subject(tab)}.bounds.scale ?? 1`);
  await app.main(`(()=>{const p=${overlay};p.sendInputEvent({type:'mouseDown',x:${Math.round(point.x * scale)},y:${Math.round(point.y * scale)},button:'left',clickCount:1});p.sendInputEvent({type:'mouseUp',x:${Math.round(point.x * scale)},y:${Math.round(point.y * scale)},button:'left',clickCount:1});})()`);
}
async function action(label: string) {
  const point = await app.main<{ x: number; y: number }>(`${overlay}.executeJavaScript(${JSON.stringify(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>(b.getAttribute('aria-label')||b.textContent).trim()===${JSON.stringify(label)} && b.getBoundingClientRect().width>0);if(!b)throw Error('Action missing');const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)})`);
  await app.main(`(()=>{const p=${overlay};p.sendInputEvent({type:'mouseDown',x:${Math.round(point.x)},y:${Math.round(point.y)},button:'left',clickCount:1});p.sendInputEvent({type:'mouseUp',x:${Math.round(point.x)},y:${Math.round(point.y)},button:'left',clickCount:1})})()`);
}
async function download(filename: string, text: string) {
  await app.main(`${subject(tab)}.view.webContents.executeJavaScript(${JSON.stringify(`(()=>{const a=document.createElement('a');a.download=${JSON.stringify(filename)};a.href=URL.createObjectURL(new Blob([${JSON.stringify(text)}],{type:'application/octet-stream'}));a.click()})()`)})`);
}
async function events() {
  return app.main<Array<{ type: string; reason?: string; path?: string; output_id?: string; size_bytes?: number }>>("globalThis.browserAgentSubject.events?.get('conversation:general') ?? []");
}
try {
  await app.page.reload(); await shellReady(app, "en"); await app.click(getAppCopy("en-US").space.general);
  await app.call("open");
  tab = await app.call<string>("create", { owner: "conversation:general", profile: "signed_out", url: app.url });
  await app.click("Show browser"); await app.call("activate", { id: tab }); await nativeAligned(app);
  await waitBrowser(() => app.main(`${subject(tab)}.status === 'idle' && ${subject(tab)}.view.webContents.getTitle() === 'Browser fixture'`), "fixture page");
  await app.call("pick", { id: tab, value: true }); await pick("h1");
  await waitBrowser(() => app.main(`${subject(tab)}.selections?.length === 1`), "heading pick");
  await pick("p"); await waitBrowser(() => app.main(`${subject(tab)}.selections?.length === 2`), "two picks");
  const baseline = process.env.BUTLER_BROWSER_BASELINE === "1";
  for (const language of process.env.BUTLER_BROWSER_ACTIONS_ONLY === "1" ? [] : ["en", "ko"]) for (const theme of ["light", "dark"]) for (const width of [1440, 1100]) {
    await app.settings(language, theme, width); await app.call("activate", { id: tab }); await nativeAligned(app);
    await app.call("pick", { id: tab, value: true });
    await app.shot(`${baseline ? "before" : "after"}-${language}-${theme}-${width}`, true);
    if (!baseline) {
      const labels = language === "ko" ? ["이미지 저장", "텍스트 복사"] : ["Save image", "Copy text"];
      for (const label of labels) assert.ok(await app.main(`${overlay}.executeJavaScript(${JSON.stringify(`Boolean([...document.querySelectorAll('button')].find(b=>(b.getAttribute('aria-label')||b.textContent).trim()===${JSON.stringify(label)} && b.getBoundingClientRect().width>0))`)})`), label);
    }
  }
  if (!baseline) {
    await app.settings("en", "light", 1440); await app.call("activate", { id: tab }); await nativeAligned(app);
    const requireElectron = `process.getBuiltinModule('module').createRequire(${JSON.stringify(join(process.cwd(), "packages/butler-app/client/electron/package.json"))})('electron')`;
    const crops = await app.main<string[]>(`${subject(tab)}.selections.map(s=>s.crop)`);
    await app.main(`(()=>{const e=${requireElectron};globalThis.downloadOpened=[];e.shell.openPath=async p=>{globalThis.downloadOpened.push(p);return ''};globalThis.pickSaved=[];e.dialog.showSaveDialog=async()=>{const filePath=${JSON.stringify(join(evidence, "crop-"))}+globalThis.pickSaved.length+'.jpg';globalThis.pickSaved.push(filePath);return {canceled:false,filePath}}})()`);
    await app.main(`(()=>{const e=${requireElectron},write=e.clipboard.writeText.bind(e.clipboard);globalThis.copyWrites=[];e.clipboard.writeText=text=>{globalThis.copyWrites.push(text);write(text)};const s=globalThis.browserAgentSubject.selection,command=s.command.bind(s);globalThis.selectionCommands=[];s.command=(op,id)=>{globalThis.selectionCommands.push({op,id});return command(op,id)}})()`);
    await action("Copy text");
    await waitBrowser(() => app.main("globalThis.copyWrites.length === 1"), "copy command reaches native clipboard");
    assert.deepEqual(await app.main("globalThis.copyWrites"), ["Browser fixture\n\nComplete page content"]);
    const clipboardReadback = await app.main<boolean>(`${requireElectron}.clipboard.readText() === 'Browser fixture\\n\\nComplete page content'`);
    await app.main(`${subject(tab)}.view.webContents.executeJavaScript("(()=>{const t=document.createElement('textarea');t.id='clipboard-target';document.body.append(t);t.focus()})()")`);
    await app.main(`${subject(tab)}.view.webContents.paste()`);
    const clipboardPaste = await app.main<boolean>(`${subject(tab)}.view.webContents.executeJavaScript(${JSON.stringify("document.querySelector('#clipboard-target').value === 'Browser fixture\\n\\nComplete page content'")})`);
    assert.ok(clipboardReadback || clipboardPaste, "picked text is available through the OS clipboard");
    await action("Save image");
    await waitBrowser(() => app.main("globalThis.pickSaved.length === 2 && globalThis.browserAgentSubject.nativeCovers === 0"), "both crops saved");
    for (const [index, crop] of crops.entries()) assert.deepEqual(readFileSync(join(evidence, `crop-${index}.jpg`)), Buffer.from(crop.split(",")[1]!, "base64"));
    await app.call("pick", { id: tab, value: false });
    const userDir = join(evidence, "user-downloads");
    await app.main(`${requireElectron}.app.setPath('downloads', ${JSON.stringify(userDir)})`);
    const completedBeforeUser = (await events()).filter(e => e.type === "download_completed").length;
    const conversation = tab;
    await app.call("control", { id: tab, holder: "user" });
    await download("mine.txt", "conversation download");
    await waitBrowser(() => app.main("globalThis.browserAgentSubject.downloads.list()[0]?.state === 'done'"), "conversation user download finished");
    const mine = await app.call<string>("create", { url: app.url });
    await waitBrowser(() => app.main(`${subject(mine)}.status === 'idle'`), "my tab fixture");
    tab = mine;
    await download("mine.txt", "my download");
    await waitBrowser(() => app.main("globalThis.browserAgentSubject.downloads.list()[0]?.name === 'mine (1).txt' && globalThis.browserAgentSubject.downloads.list()[0].state === 'done'"), "my tab download finished");
    const userDownloads = [join(userDir, "mine.txt"), join(userDir, "mine (1).txt")];
    assert.equal(readFileSync(userDownloads[0]!, "utf8"), "conversation download");
    assert.equal(readFileSync(userDownloads[1]!, "utf8"), "my download");
    assert.equal((await events()).filter(e => e.type === "download_completed").length, completedBeforeUser);
    assert.equal(await app.main("globalThis.browserAgentSubject.nativeCovers"), 0);
    assert.equal(await app.main("globalThis.pickSaved.length"), crops.length);
    await app.main("globalThis.browserAgentSubject.downloads.persistence");
    const userData = await app.main<string>(`${requireElectron}.app.getPath('userData')`);
    const history = JSON.parse(readFileSync(join(userData, "browser-downloads", "history.json"), "utf8")) as Array<{ name: string }>;
    assert.deepEqual(history.map(entry => entry.name), ["mine (1).txt", "mine.txt"]);

    tab = conversation;
    await app.call("activate", { id: tab });
    await app.call("control", { id: tab, holder: "agent" });
    const invoice = "%PDF-1.4\nInvoice 42\n%%EOF\n";
    await download("invoice.pdf", invoice);
    await waitBrowser(async () => (await events()).some(e => e.type === "download_completed"), "invoice download finished");
    const receipt = (await events()).find(e => e.type === "download_completed")!;
    assert.equal(receipt.output_id, undefined);
    const artifacts = await app.gateway.api<{ artifacts: Array<{ title: string }> }>("/artifacts?session_id=general");
    assert.ok(artifacts.artifacts.every(a => a.title !== "invoice.pdf"));
    assert.equal(readFileSync(join(app.gateway.butlerData, receipt.path!), "utf8"), invoice);
    const canonical = await app.gateway.api<any>("/session-view?session_id=general");
    const stream = await app.gateway.api<any>("/events?limit=10");
    writeFileSync(join(evidence, "download-projection.json"), JSON.stringify({
      messages: canonical.messages?.map((m: any) => ({ turn: m.turn_id, artifacts: m.artifacts?.map((a: any) => a.title) })),
      artifacts: canonical.artifacts?.map((a: any) => a.title), events: stream.events?.map((e: any) => ({ type: e.type })),
    }, null, 2));
    await download("program.exe", "MZ-do-not-open");
    await waitBrowser(async () => (await events()).filter(e => e.type === "download_completed").length === 2, "executable download finished");
    assert.deepEqual(await app.main("globalThis.downloadOpened"), []);
    const oversized = createServer((_request, response) => {
      response.writeHead(200, { "content-disposition": 'attachment; filename="too-large.bin"', "content-length": "100000001" });
      response.flushHeaders(); response.write(Buffer.alloc(64 * 1024));
    });
    await new Promise<void>(done => oversized.listen(0, "127.0.0.1", done));
    const oversizedAddress = oversized.address() as { port: number };
    try {
      await app.main(`${subject(tab)}.view.webContents.downloadURL(${JSON.stringify(`http://127.0.0.1:${oversizedAddress.port}/`)})`);
      await waitBrowser(async () => (await events()).some(e => e.reason === "download_file_limit"), "100 MB file limit event");
    } finally { oversized.closeAllConnections(); await new Promise<void>(done => oversized.close(() => done())); }
    await app.main("globalThis.browserAgentSubject.downloads.totals['conversation:general']=500000000");
    await download("over-session.txt", "limit");
    await waitBrowser(async () => (await events()).some(e => e.reason === "download_session_limit"), "500 MB session limit event");

    const stalled = createServer((_request, response) => {
      response.writeHead(200, { "content-disposition": 'attachment; filename="stalled.bin"', "content-length": "100000001" });
      response.flushHeaders(); response.write(Buffer.alloc(64 * 1024));
    });
    await new Promise<void>(done => stalled.listen(0, "127.0.0.1", done));
    const stalledAddress = stalled.address() as { port: number };
    try {
      await app.main(`${subject(mine)}.view.webContents.downloadURL(${JSON.stringify(`http://127.0.0.1:${stalledAddress.port}/`)})`);
      await waitBrowser(() => app.main("globalThis.browserAgentSubject.downloads.list()[0]?.name === 'stalled.bin' && globalThis.browserAgentSubject.downloads.list()[0].state === 'progress'"), "stalled user download in progress");
      const current = await app.main<Array<{ id: string }>>("globalThis.browserAgentSubject.downloads.list()");
      const next = await app.main<Array<{ name: string; state: string }>>("(async()=>{const d = globalThis.browserAgentSubject.downloads; await d.persistence; const next = new d.constructor(globalThis.browserAgentSubject, d.directory); return next.list();})()");
      assert.equal(next.length, current.length);
      assert.equal(next[0]?.name, "stalled.bin");
      assert.equal(next[0]?.state, "failed");
      await app.main(`globalThis.browserAgentSubject.downloads.cancelEntry(${JSON.stringify(current[0]!.id)})`);
    } finally { stalled.closeAllConnections(); await new Promise<void>(done => stalled.close(() => done())); }
    await nativeAligned(app);
    await app.click("Downloads");
    await waitBrowser(() => app.page.expression("document.body.innerText.includes('mine (1).txt') && document.body.innerText.includes('invoice.pdf')"), "user and agent downloads in the popover");
    await waitBrowser(() => app.main(`${subject(tab)}.covered && (${subject(tab)}.attached !== ${app.win} || !${subject(tab)}.view.getVisible())`), "downloads popover covers the native page");
    await app.shot("downloads-popover", true);
    writeFileSync(join(evidence, "acceptance.json"), JSON.stringify({ functional: true, clipboardQualified: clipboardReadback || clipboardPaste, events: await events(), crops: crops.length, clipboardReadback, clipboardPaste, executableOpened: false, userDownloads }, null, 2));
  }
} catch (error) {
  writeFileSync(join(evidence, "failure.json"), JSON.stringify({ error: String(error), lastMain: app.lastMain(), selection: await app.main("({commands:globalThis.selectionCommands,writes:globalThis.copyWrites,picks:globalThis.browserAgentSubject.tabs.get(globalThis.browserAgentSubject.activeId)?.selections?.map(s=>s.text)})").catch(() => null), events: await events().catch(() => []) }));
  await app.shot("failure").catch(() => {}); throw error;
} finally { await app.stop(); }
