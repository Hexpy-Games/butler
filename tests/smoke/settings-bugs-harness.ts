// Nonvisual public-component smoke against the isolated native gateway.
// Browser screenshots remain a separate Playwright acceptance gate.
import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { createNativeAppServer } from "../support/native-app-server";

const server = await createNativeAppServer({ uiRoot: resolve("packages/butler-app/client/ui/dist") });
const dom = new JSDOM('<div id="root"></div>', { url: server.url, pretendToBeVisual: true });
const { window } = dom;
Object.assign(globalThis, {
  window, document: window.document, navigator: window.navigator,
  HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement,
  HTMLButtonElement: window.HTMLButtonElement, Node: window.Node, NodeFilter: window.NodeFilter,
  MutationObserver: window.MutationObserver, CustomEvent: window.CustomEvent,
  getComputedStyle: window.getComputedStyle, IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
});
window.matchMedia = (query) => ({ matches: false, media: query, onchange: null,
  addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false });
const nativeFetch = fetch;
let imports = 0;
let deletes = 0;
let rejectToggle = false;
Object.assign(globalThis, { fetch: async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, server.url);
  if (url.pathname === "/skills/import") imports += 1;
  if (init?.method === "DELETE") deletes += 1;
  if (rejectToggle && url.pathname.endsWith("/harness") && init?.method === "PATCH") {
    return Response.json({ error: { message: "Rejected toggle" } }, { status: 503 });
  }
  return nativeFetch(url, { ...init, headers: { ...server.authHeaders, ...init?.headers } });
} });
const uiSource = resolve("packages/butler-app/client/ui/src");
const { act, createElement: h, Fragment } = await import(Bun.resolveSync("react", uiSource));
const { createRoot } = await import(Bun.resolveSync("react-dom/client", uiSource));
const { McpSettings } = await import(Bun.resolveSync("./components/settings/McpSettings", uiSource));
const { SkillsSettings } = await import(Bun.resolveSync("./components/settings/SkillsSettings", uiSource));
const { CommandPalette } = await import(Bun.resolveSync("./components/command/CommandPalette", uiSource));
const { AppConfirmationDialog } = await import(Bun.resolveSync("./components/common/AppConfirmationDialog", uiSource));
const { Toaster } = await import(Bun.resolveSync("./libs/design-system", uiSource));
const { appCopy, setAppCopyLanguage } = await import(Bun.resolveSync("./app/copy", uiSource));
const { useAutomationStore } = await import(Bun.resolveSync("./stores/automationStore", uiSource));
setAppCopyLanguage("ko");
const root = createRoot(window.document.getElementById("root")!);
const doc = window.document;

async function waitFor(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) await act(async () => { await Bun.sleep(20); });
  assert(predicate(), message);
}
function button(label: string, scope: ParentNode = doc): HTMLButtonElement {
  const element = [...scope.querySelectorAll<HTMLButtonElement>("button")]
    .find((node) => node.textContent?.trim() === label || node.getAttribute("aria-label") === label);
  assert(element, `button exists: ${label}`);
  return element;
}
async function click(element: HTMLElement) { await act(async () => element.click()); }
async function fill(id: string, value: string) {
  const input = doc.querySelector<HTMLInputElement>(id)!;
  assert(input, id);
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}
async function render(element: unknown) {
  await act(async () => root.render(h(Fragment, null, element, h(AppConfirmationDialog), h(Toaster))));
}
async function confirmation(accepted: boolean) {
  await waitFor(() => Boolean(doc.querySelector('[role="alertdialog"]')), "confirmation shown");
  await click(button(accepted ? appCopy.common.delete : appCopy.common.cancel, doc.querySelector('[role="alertdialog"]')!));
}

async function mcpChecks() {
  await server.api("/mcp-servers", { method: "POST", body: JSON.stringify({ id: "harness", display_name: "검증 서버", enabled: true, transport: "stdio", command: "false" }) });
  await render(h(McpSettings));
  await waitFor(() => Boolean(doc.querySelector('[role="switch"]')), "MCP loaded");
  assert.equal(doc.querySelector('[role="switch"]')!.getAttribute("aria-checked"), "true");
  assert(doc.body.textContent?.includes(appCopy.settings.mcpEnabled));
  rejectToggle = true;
  await click(doc.querySelector<HTMLElement>('[role="switch"]')!);
  await waitFor(() => Boolean(doc.querySelector('[data-sonner-toast][data-type="error"]')), "toggle error shown");
  assert.equal(doc.querySelector('[role="switch"]')!.getAttribute("aria-checked"), "true");
  rejectToggle = false;
  await click(doc.querySelector<HTMLElement>('[role="switch"]')!);
  await waitFor(() => doc.querySelector('[role="switch"]')?.getAttribute("aria-checked") === "false", "toggle updates in place");
  await click(button(appCopy.settings.actions.addMcpServer));
  assert.equal(button(appCopy.common.save).disabled, true);
  await fill("#mcp-server-id", "깃허브");
  assert.equal(button(appCopy.common.save).disabled, true);
  await fill("#mcp-server-id", "GitHub");
  await fill("#mcp-server-name", "입력을 유지합니다");
  assert(doc.body.textContent?.includes(appCopy.settings.mcpIdPreview("github")));
  await click(button(appCopy.common.save));
  await waitFor(() => doc.body.textContent?.includes(appCopy.settings.mcpCommandRequired) === true, "native 400 localized");
  assert.equal(doc.querySelector<HTMLInputElement>("#mcp-server-name")!.value, "입력을 유지합니다");
  await click(button(appCopy.common.cancel));
  await click(button(appCopy.settings.actions.deleteMcpServer));
  assert.equal(deletes, 0);
  await confirmation(false);
  assert.equal(deletes, 0);
  await click(button(appCopy.settings.actions.deleteMcpServer));
  await confirmation(true);
  await waitFor(() => doc.body.textContent?.includes(appCopy.interfaceDetails.noMcp) === true, "confirmed server removed");
  assert.equal(deletes, 1);
}

async function skillChecks() {
  await render(h(SkillsSettings));
  await waitFor(() => [...doc.querySelectorAll("button")].some((node) => node.textContent?.trim() === appCopy.settings.actions.importSkill), "skills loaded");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await click(button(appCopy.settings.actions.importSkill));
    const input = doc.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { configurable: true, value: [new File(["invalid zip"], "invalid.zip")] });
    await act(async () => input.dispatchEvent(new window.Event("change", { bubbles: true })));
    await waitFor(() => imports === attempt + 1 && doc.body.textContent?.includes(appCopy.interfaceFeedback.importFailed) === true, "import rejection displayed");
    assert.equal(input.value, "");
  }
  assert.equal(imports, 2);
}

async function paletteChecks() {
  await render(h(CommandPalette, { onClose: () => {} }));
  await waitFor(() => doc.querySelectorAll('[role="option"]').length === 14, "all settings present");
  for (const [query, label] of [["모델", appCopy.settings.sections.models], ["models", appCopy.settings.sections.models], ["스킬", appCopy.settings.sections.skills], ["mcp", appCopy.settings.sections.mcp]]) {
    await fill('[role="combobox"]', query!);
    await waitFor(() => [...doc.querySelectorAll('[role="option"]')].some((node) => node.textContent?.includes(label!)), `localized search: ${query}`);
  }
  await fill('[role="combobox"]', "logs");
  await waitFor(() => doc.querySelectorAll('[role="option"]').length === 0, "developer logs hidden");
}

async function scheduleChecks() {
  await render(null);
  const created = await server.api<{ automation: { id: string } }>("/automations", { method: "POST", body: JSON.stringify({ title: "삭제 검증", prompt_body: "stub", target_session_id: "general", interval_seconds: 86400 }) });
  await useAutomationStore.getState().initialize(created.automation.id, [], () => {});
  const before = deletes;
  let operation!: Promise<void>;
  await act(async () => { operation = useAutomationStore.getState().remove(async () => {}, () => {}, () => {}); });
  assert.equal(deletes, before);
  await confirmation(false);
  await operation;
  assert.equal(deletes, before);
  await act(async () => { operation = useAutomationStore.getState().remove(async () => {}, () => {}, () => {}); });
  await confirmation(true);
  await operation;
  assert.equal(deletes, before + 1);
}

try {
  await mcpChecks();
  await skillChecks();
  await paletteChecks();
  await scheduleChecks();
  assert.equal(server.stubModelCalls.length, 0);
  console.log(JSON.stringify({ ok: true, transport: "DOM/native-gateway", imports, deletes, modelCalls: 0, screenshots: "unavailable" }));
} finally {
  await act(async () => root.unmount());
  globalThis.fetch = nativeFetch;
  dom.window.close();
  await server.stop();
}
