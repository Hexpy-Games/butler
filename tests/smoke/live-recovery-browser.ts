// Actual SSE response, connection hook, toolbar and submit hook in an isolated preview.
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createTestAppServer } from "../../packages/butler-agent/src/test-support/app-server.ts";
import { liveEventsResponse } from "../../packages/butler-agent/src/gateways/app/interface/server/live-events.ts";

const root = await mkdtemp(join(tmpdir(), "butler-live-recovery-"));
const backend = createTestAppServer({ dbPath: join(root, "test.sqlite"), butlerData: root, port: 0, automationSchedulerIntervalMs: false });
const output = "/tmp/live-recovery-browser";
await mkdir(output, { recursive: true });
let accept = true;
const streams = new Set<AbortController>();
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
  if (!accept) return new Response("offline", { status: 503, headers: { "access-control-allow-origin": "*" } });
  const shutdown = new AbortController(); streams.add(shutdown);
  const response = liveEventsResponse(backend.store, Number(new URL(request.url).searchParams.get("cursor")),
    { serverShutdownSignal: shutdown.signal, clientDisconnectSignal: request.signal });
  response.headers.set("access-control-allow-origin", "*");
  return response;
} });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
try {
  await page.goto("http://127.0.0.1:5173/?visual=design-system");
  await page.getByRole("tab", { name: "Blocks", exact: true }).waitFor();
  await page.evaluate(async serverUrl => {
    const load = (path: string) => import(path);
    const hookPath = "/src/hooks/live-session/useLiveSessionEvents.ts";
    const source = await (await fetch(hookPath)).text();
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map(match => match[1]!);
    const reactPath = imports.find(path => /\/react.js\?/.test(path))!;
    const React = (await import(reactPath)).default;
    const { createRoot } = (await import(reactPath.replace("/react.js?", "/react-dom_client.js?"))).default;
    const { useButlerStore } = await import(imports.find(path => path.includes("/app/store.ts"))!);
    const copy = await import(imports.find(path => path.includes("/app/copy.ts"))!);
    copy.setAppCopyLanguage("ko");
    const { useLiveSessionEvents } = await import(hookPath);
    const { ComposerToolbar } = await load("/src/components/conversation/ComposerToolbar.tsx");
    const { useComposerStore } = await load("/src/components/conversation/composerStore.ts");
    const { useComposerSubmit } = await load("/src/components/conversation/hooks/useComposerSubmit.ts");
    const { useComposerKeyboard } = await load("/src/components/conversation/hooks/useComposerKeyboard.ts");
    const { LiveConnectionNotice } = await load("/src/components/layout/LiveConnectionNotice.tsx");
    const { ComposerCard, ComposerCardTextarea } = await load("/src/libs/design-system/index.ts");
    window.butlerApp = { serverUrl };
    useComposerStore.setState({ canSend: true, text: "연결이 복구되어도 이 초안은 유지됩니다." });
    (window as any).sent = 0;
    function Preview() {
      useLiveSessionEvents();
      const text = useComposerStore((state: any) => state.text);
      const setText = useComposerStore((state: any) => state.setText);
      const submit = useComposerSubmit({ text, setText, attachments: [], setAttachments() {},
        isSending: false, activeTurn: false, uploadingCount: 0, model: "test", reasoning: "medium",
        accessMode: "full_access", planMode: false, controlsTouched: false, setModelMenuOpen() {}, setAccessMenuOpen() {},
        onSend() { (window as any).sent++; } });
      const keyboard = useComposerKeyboard({ isComposing: false, multilineSendBehavior: "enter_send_shift_enter_newline",
        setModelMenuOpen() {}, setAccessMenuOpen() {}, submit });
      return React.createElement(React.Fragment, null, React.createElement(LiveConnectionNotice),
        React.createElement(ComposerCard, { onSubmit: submit, expanded: true },
          React.createElement(ComposerCardTextarea, { "aria-label": "메시지 입력", value: text,
            onChange: (e: { target: { value: string } }) => setText(e.target.value), onKeyDown: keyboard }), React.createElement(ComposerToolbar)));
    }
    for (const child of document.body.children) (child as HTMLElement).style.display = "none";
    const host = document.createElement("div");
    host.style.cssText = "position:fixed;inset:0;padding:16px;display:flex;align-items:end;background:var(--surface-raised)";
    document.body.append(host);
    createRoot(host).render(React.createElement(Preview));
    (window as any).connectionLost = () => useButlerStore.getState().liveConnectionLost;
  }, server.url.toString());
  const send = page.locator('[data-test-class="composer-send-button"]');
  await page.waitForFunction(() => (window as any).connectionLost?.() === false);
  assert.equal(await send.isEnabled(), true);
  accept = false;
  for (const stream of streams) stream.abort();
  await page.waitForFunction(() => (window as any).connectionLost());
  assert.equal(await send.getAttribute("aria-busy"), "true");
  assert.equal(await send.isDisabled(), true);
  const draft = await page.getByRole("textbox").inputValue();
  await page.getByRole("textbox").press("Enter");
  assert.equal(await page.getByRole("textbox").inputValue(), draft);
  assert.equal(await page.evaluate(() => (window as any).sent), 0);
  for (const width of [1280, 430, 390, 375, 320]) {
    await page.setViewportSize({ width, height: 600 });
    await send.scrollIntoViewIfNeeded();
    assert.match(await send.locator("svg").evaluate(el => getComputedStyle(el).animationName), /connection-spin/);
    const notice = page.locator('[data-test-class="live-connection-notice"]');
    assert.equal(await notice.evaluate(el => getComputedStyle(el).position), "absolute");
    await page.screenshot({ path: `${output}/${width}-reconnecting.png` });
  }
  accept = true;
  await page.waitForFunction(() => (window as any).connectionLost() === false);
  assert.equal(await send.isEnabled(), true);
  assert.equal(await send.getAttribute("aria-busy"), null);
  assert.equal(await page.locator('[data-test-class="live-connection-notice"]').count(), 0);
  assert.equal(await page.getByRole("textbox").inputValue(), draft);
  assert.equal(await page.evaluate(() => (window as any).sent), 0);
  await page.screenshot({ path: `${output}/320-recovered.png` });
  console.log(`PASS: actual SSE disconnect/recovery -> toolbar; Enter guarded; draft preserved; 5 widths. ${output}`);
} finally { await browser.close(); for (const stream of streams) stream.abort(); await server.stop(true); backend.stop(); }
