/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { getAppCopy, setAppCopyLanguage } from "@/app/copy.ts";
import { useConfirmationStore } from "@/app/confirmation.ts";
import type { SecurityView } from "@/app/types.ts";
import { normalizeSettingsSectionId } from "@/app/utils.ts";
import { SecuritySettings } from "./SecuritySettings";

setAppCopyLanguage("en");
const copy = getAppCopy("en-US").settings;

const view = (overrides: Partial<SecurityView> = {}): SecurityView => ({
  remote_access_enabled: false,
  bind_addresses: ["127.0.0.1:18765"],
  lan_urls: [],
  connection_code: { masked: "abcd…wxyz", created_at: "2026-09-28T01:00:00Z" },
  ...overrides,
});

const ok = (data: unknown) => ({ ok: true, data });
const forbidden = { ok: false, error: { schema: "butler.app.bridge-error.v1", code: "security_loopback_only", status: 403 } };
const FULL_CODE = "c".repeat(43);

type Call = [method: string, input?: unknown];

/** A desktop bridge double for the security routes; `server` holds the gateway state. */
function securityBridge(server: { view: SecurityView; forbid?: Set<string>; fail?: Set<string> }) {
  const calls: Call[] = [];
  const reply = (method: string, data: () => unknown) => async (input?: unknown) => {
    calls.push(input === undefined ? [method] : [method, input]);
    if (server.forbid?.has(method)) return forbidden;
    if (server.fail?.has(method)) return { ok: false, error: { schema: "butler.app.bridge-error.v1", code: "request_failed", status: 500 } };
    return ok(data());
  };
  return {
    calls,
    bridge: {
      getSecurity: reply("getSecurity", () => server.view),
      updateSettings: reply("updateSettings", () => ({})),
      revealConnectionCode: reply("revealConnectionCode", () => ({ code: FULL_CODE })),
      rotateConnectionCode: reply("rotateConnectionCode", () => {
        server.view = view({ connection_code: { masked: "efgh…stuv", created_at: "2026-09-29T01:00:00Z" } });
        return { code: "d".repeat(43), created_at: "2026-09-29T01:00:00Z" };
      }),
    },
  };
}

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

async function mount(bridge: Record<string, unknown>) {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const clipboard: string[] = [];
  Object.defineProperty(dom.window.navigator, "clipboard", {
    value: { writeText: async (text: string) => { clipboard.push(text); } },
  });
  class ResizeObserver { observe() {} unobserve() {} disconnect() {} }
  const matchMedia = (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  });
  Object.assign(dom.window, { butlerApp: bridge, ResizeObserver, matchMedia });
  const globals: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
    DocumentFragment: dom.window.DocumentFragment, Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent, PointerEvent: dom.window.MouseEvent,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), ResizeObserver, matchMedia,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.assign(globalThis, globals);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  await act(async () => root.render(<SecuritySettings />));
  await settle();
  cleanup = async () => {
    await act(async () => root.unmount());
    useConfirmationStore.getState().pending?.resolve(false);
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    dom.window.close();
  };
  const document = dom.window.document;
  const button = (label: string) => Array.from(document.querySelectorAll("button"))
    .find((candidate) => candidate.textContent?.trim() === label) as HTMLButtonElement | undefined;
  const click = async (element: Element | null | undefined) => {
    expect(element).toBeTruthy();
    await act(async () => { (element as HTMLElement).click(); });
    await settle();
  };
  const codeInput = () => document.querySelector<HTMLInputElement>('[data-setting-id="connection-code"] input');
  return { document, clipboard, button, click, settle, codeInput };
}

test("security shows the masked code with its created date and no LAN URLs while off", async () => {
  const { calls, bridge } = securityBridge({ view: view() });
  const { document, codeInput, button } = await mount(bridge);
  expect(calls).toEqual([["getSecurity"]]);
  expect(Array.from(document.querySelectorAll("[data-settings-section-id]"))
    .map((section) => section.getAttribute("data-settings-section-id"))).toEqual(["remote-access", "connection-code"]);
  expect(document.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
  expect(document.querySelector('[data-setting-id="lan-urls"]')).toBeNull();
  expect(codeInput()?.value).toBe("abcd…wxyz");
  expect(codeInput()?.readOnly).toBe(true);
  expect(document.querySelector('[data-setting-id="connection-code"]')?.textContent).toContain(
    copy.security.createdAt(new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(new Date("2026-09-28T01:00:00Z"))),
  );
  for (const label of [copy.security.reveal, copy.security.copy, copy.security.rotate]) expect(button(label)).toBeTruthy();
});

test("the remote access toggle sends the security PATCH payload and lists LAN URLs with copy", async () => {
  const server = { view: view() };
  const { calls, bridge } = securityBridge(server);
  const { document, click, clipboard } = await mount(bridge);

  server.view = view({ remote_access_enabled: true, lan_urls: ["http://192.0.2.7:18765", "http://studio.local:18765"] });
  await click(document.querySelector('[role="switch"]'));
  expect(calls.slice(1)).toEqual([
    ["updateSettings", { security: { remote_access_enabled: true } }],
    ["getSecurity"],
  ]);
  expect(document.querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("true");
  const urls = Array.from(document.querySelectorAll('[data-setting-id="lan-urls"] code')).map((node) => node.textContent);
  expect(urls).toEqual(["http://192.0.2.7:18765", "http://studio.local:18765"]);
  await click(document.querySelector(`[data-setting-id="lan-urls"] button[aria-label="${copy.security.copyAddress}"]`));
  expect(clipboard).toEqual(["http://192.0.2.7:18765"]);

  server.view = view();
  await click(document.querySelector('[role="switch"]'));
  expect(calls.slice(3)).toEqual([
    ["updateSettings", { security: { remote_access_enabled: false } }],
    ["getSecurity"],
  ]);
  expect(document.querySelector('[data-setting-id="lan-urls"]')).toBeNull();
});

test("reveal shows the full code and hide masks it again", async () => {
  const { calls, bridge } = securityBridge({ view: view() });
  const { button, click, codeInput } = await mount(bridge);
  await click(button(copy.security.reveal));
  expect(calls.at(-1)).toEqual(["revealConnectionCode"]);
  expect(codeInput()?.value).toBe(FULL_CODE);
  await click(button(copy.security.hide));
  expect(codeInput()?.value).toBe("abcd…wxyz");
  expect(calls.filter(([method]) => method === "revealConnectionCode")).toHaveLength(1);
});

test("copy writes the full code to the clipboard without showing it", async () => {
  const { calls, bridge } = securityBridge({ view: view() });
  const { button, click, codeInput, clipboard } = await mount(bridge);
  await click(button(copy.security.copy));
  expect(calls.at(-1)).toEqual(["revealConnectionCode"]);
  expect(clipboard).toEqual([FULL_CODE]);
  expect(codeInput()?.value).toBe("abcd…wxyz");
});

test("rotate asks first: cancel sends nothing, confirm rotates and shows the new masked code", async () => {
  const { calls, bridge } = securityBridge({ view: view() });
  const { button, click, settle, codeInput } = await mount(bridge);

  await click(button(copy.security.rotate));
  const pending = useConfirmationStore.getState().pending;
  expect(pending?.message).toBe(copy.security.rotateConfirm);
  expect(pending?.confirmLabel).toBe(copy.security.rotate);
  expect(pending?.destructive).toBe(true);
  pending?.resolve(false);
  await settle();
  expect(calls.map(([method]) => method)).not.toContain("rotateConnectionCode");

  await click(button(copy.security.reveal));
  await click(button(copy.security.rotate));
  useConfirmationStore.getState().pending?.resolve(true);
  await settle();
  expect(calls.slice(-2)).toEqual([["rotateConnectionCode"], ["getSecurity"]]);
  expect(codeInput()?.value).toBe("efgh…stuv");
});

test("a 403 from the loopback-only rule shows a host-only line instead of the controls", async () => {
  const { bridge } = securityBridge({ view: view(), forbid: new Set(["getSecurity"]) });
  const { document } = await mount(bridge);
  expect(document.querySelector('[data-slot="settings-section-empty"]')?.textContent).toBe(copy.security.hostOnly);
  expect(document.querySelector('[data-slot="settings-section-error"]')).toBeNull();
  expect(document.querySelector('[role="switch"]')).toBeNull();
  expect(document.querySelector('[data-settings-section-id="connection-code"]')).toBeNull();
});

test("a 403 on an action switches the page to the host-only line", async () => {
  const server = { view: view(), forbid: new Set<string>() };
  const { bridge } = securityBridge(server);
  const { document, button, click } = await mount(bridge);
  server.forbid.add("revealConnectionCode");
  await click(button(copy.security.reveal));
  expect(document.querySelector('[data-slot="settings-section-empty"]')?.textContent).toBe(copy.security.hostOnly);
  expect(document.querySelector('[data-settings-section-id="connection-code"]')).toBeNull();
});

test("other load failures show the section error with Retry", async () => {
  const server = { view: view(), fail: new Set(["getSecurity"]) };
  const { calls, bridge } = securityBridge(server);
  const { document, button, click } = await mount(bridge);
  expect(document.querySelector('[data-slot="settings-section-error"]')).not.toBeNull();
  server.fail.clear();
  await click(button(copy.sectionState.retry));
  expect(calls).toEqual([["getSecurity"], ["getSecurity"]]);
  expect(document.querySelector('[role="switch"]')).not.toBeNull();
});

test("settings routes resolve the security section in both locales", () => {
  expect(normalizeSettingsSectionId("security")).toBe("security");
  expect(normalizeSettingsSectionId("settings:security")).toBe("security");
  expect(normalizeSettingsSectionId("보안")).toBe("security");
  expect(getAppCopy("ko-KR").settings.sections.security).toBe("보안");
  expect(getAppCopy("ko-KR").settings.security.remoteAccess).toBe("다른 컴퓨터에서 접속 허용");
  expect(copy.security.remoteAccess).toBe("Allow access from other devices");
});
