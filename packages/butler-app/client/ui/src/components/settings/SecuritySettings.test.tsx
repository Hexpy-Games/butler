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
  allowed_hosts: ["butler.example.com"],
  connection_code: { masked: "abcd…wxyz", created_at: "2026-09-28T01:00:00Z" },
  ...overrides,
});

const ok = (data: unknown) => ({ ok: true, data });
const failure = (code: string, status: number) => ({ ok: false, error: { schema: "butler.app.bridge-error.v1", code, status } });
const forbidden = failure("loopback_required", 403);
const FULL_CODE = "c".repeat(43);

type Call = [method: string, input?: unknown];

/** A desktop bridge double for the security routes; `server` holds the gateway state. */
function securityBridge(server: {
  view: SecurityView;
  forbid?: Set<string>;
  fail?: Set<string>;
  failWith?: ReturnType<typeof failure>;
}) {
  const calls: Call[] = [];
  const reply = (method: string, data: (input?: unknown) => unknown) => async (input?: unknown) => {
    calls.push(input === undefined ? [method] : [method, input]);
    if (server.forbid?.has(method)) return forbidden;
    if (server.fail?.has(method)) return server.failWith ?? failure("request_failed", 500);
    return ok(data(input));
  };
  return {
    calls,
    bridge: {
      getSecurity: reply("getSecurity", () => server.view),
      updateSettings: reply("updateSettings", (input) => {
        const hosts = (input as { security?: { allowed_hosts?: string[] } }).security?.allowed_hosts;
        if (hosts) server.view = { ...server.view, allowed_hosts: hosts };
        return {};
      }),
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
  const type = async (input: HTMLInputElement | null, value: string) => {
    expect(input).toBeTruthy();
    const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(input, value);
      input!.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };
  const pressEnter = async (input: HTMLInputElement | null) => {
    await act(async () => {
      input!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await settle();
  };
  const sectionIds = () => Array.from(document.querySelectorAll("[data-settings-section-id]"))
    .map((section) => section.getAttribute("data-settings-section-id"));
  return { document, clipboard, button, click, settle, codeInput, type, pressEnter, sectionIds };
}

test("security shows the masked code with its created date and no LAN URLs while off", async () => {
  const { calls, bridge } = securityBridge({ view: view() });
  const { document, codeInput, button, sectionIds } = await mount(bridge);
  expect(calls).toEqual([["getSecurity"]]);
  expect(sectionIds()).toEqual(["remote-access", "connection-code", "security-advanced"]);
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
  expect(document.querySelector('[data-settings-section-id="security-advanced"]')).toBeNull();
});

test("a 403 without the loopback_required code is a load error, not the host-only line", async () => {
  const server = { view: view(), fail: new Set(["getSecurity"]), failWith: failure("host_not_allowed", 403) };
  const { bridge } = securityBridge(server);
  const { document } = await mount(bridge);
  expect(document.querySelector('[data-slot="settings-section-error"]')).not.toBeNull();
  expect(document.querySelector('[data-slot="settings-section-empty"]')).toBeNull();
});

test("without a connection code the page omits its section; an unknown created date is left out", async () => {
  const { bridge } = securityBridge({ view: view({ connection_code: null }) });
  const { sectionIds } = await mount(bridge);
  expect(sectionIds()).toEqual(["remote-access", "security-advanced"]);
  await cleanup?.();
  cleanup = null;

  const undated = securityBridge({ view: view({ connection_code: { masked: "abcd…wxyz", created_at: null } }) });
  const { document, codeInput } = await mount(undated.bridge);
  expect(codeInput()?.value).toBe("abcd…wxyz");
  expect(document.querySelector('[data-setting-id="connection-code"]')?.textContent).not.toContain(copy.security.createdAt(""));
});

test("allowed hosts sit in a collapsed Advanced disclosure", async () => {
  const { bridge } = securityBridge({ view: view() });
  const { document, click, sectionIds } = await mount(bridge);
  const advanced = document.querySelector('[data-settings-section-id="security-advanced"]');
  expect(advanced?.querySelector('[data-slot="form-section-header"] h3')?.textContent).toBe(copy.security.advanced);
  const toggle = advanced?.querySelector<HTMLButtonElement>("[aria-expanded]");
  expect(toggle?.getAttribute("aria-expanded")).toBe("false");
  expect(toggle?.textContent).toContain(copy.security.advancedContents);
  expect(document.querySelector('[data-setting-id="allowed-hosts"]')).toBeNull();

  await click(toggle);
  expect(toggle?.getAttribute("aria-expanded")).toBe("true");
  expect(sectionIds()).toEqual(["remote-access", "connection-code", "security-advanced", "allowed-hosts"]);
  const hosts = Array.from(document.querySelectorAll('[data-setting-id="allowed-hosts"] code')).map((node) => node.textContent);
  expect(hosts).toEqual(["butler.example.com"]);
});

test("adding a host saves the whole list through PATCH /settings", async () => {
  const { calls, bridge } = securityBridge({ view: view() });
  const { document, click, button, type, pressEnter } = await mount(bridge);
  await click(document.querySelector('[data-settings-section-id="security-advanced"] [aria-expanded]'));
  const hostInput = () => document.querySelector<HTMLInputElement>('[data-setting-id="allowed-hosts"] input');
  expect(button(copy.security.addHost)?.disabled).toBe(true);

  await type(hostInput(), " Tunnel.Example.com ");
  await click(button(copy.security.addHost));
  expect(calls.slice(-2)).toEqual([
    ["updateSettings", { security: { allowed_hosts: ["butler.example.com", "tunnel.example.com"] } }],
    ["getSecurity"],
  ]);
  expect(Array.from(document.querySelectorAll('[data-setting-id="allowed-hosts"] code')).map((node) => node.textContent))
    .toEqual(["butler.example.com", "tunnel.example.com"]);
  expect(hostInput()?.value).toBe("");

  await type(hostInput(), "192.0.2.8:8443");
  await pressEnter(hostInput());
  expect(calls.at(-2)).toEqual(
    ["updateSettings", { security: { allowed_hosts: ["butler.example.com", "tunnel.example.com", "192.0.2.8:8443"] } }],
  );

  // A name already on the list sends nothing.
  const sent = calls.length;
  await type(hostInput(), "BUTLER.example.com");
  await pressEnter(hostInput());
  expect(calls).toHaveLength(sent);
  expect(hostInput()?.value).toBe("");
});

test("an invalid host is refused in place and sends nothing", async () => {
  const { calls, bridge } = securityBridge({ view: view() });
  const { document, click, button, type } = await mount(bridge);
  await click(document.querySelector('[data-settings-section-id="security-advanced"] [aria-expanded]'));
  const hostInput = () => document.querySelector<HTMLInputElement>('[data-setting-id="allowed-hosts"] input');
  const error = () => document.querySelector('[data-setting-id="allowed-hosts"] [data-slot="field-error"]');

  for (const value of ["two words", "https://butler.example.com"]) {
    await type(hostInput(), value);
    await click(button(copy.security.addHost));
    expect(error()?.textContent).toBe(copy.security.invalidHost);
    expect(hostInput()?.getAttribute("aria-invalid")).toBe("true");
  }
  expect(calls.map(([method]) => method)).not.toContain("updateSettings");

  await type(hostInput(), "butler.example.info");
  expect(error()).toBeNull();
  expect(hostInput()?.getAttribute("aria-invalid")).toBeNull();
});

test("removing a host saves the list without it", async () => {
  const { calls, bridge } = securityBridge({ view: view() });
  const { document, click } = await mount(bridge);
  await click(document.querySelector('[data-settings-section-id="security-advanced"] [aria-expanded]'));
  await click(document.querySelector(`button[aria-label="${copy.security.removeHost("butler.example.com")}"]`));
  expect(calls.slice(-2)).toEqual([
    ["updateSettings", { security: { allowed_hosts: [] } }],
    ["getSecurity"],
  ]);
  expect(document.querySelector('[data-setting-id="allowed-hosts"] code')).toBeNull();
  expect(document.querySelector('[data-setting-id="allowed-hosts"]')?.textContent).toContain(copy.security.noHosts);
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
