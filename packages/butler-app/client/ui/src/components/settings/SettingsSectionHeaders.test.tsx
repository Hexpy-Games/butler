/// <reference types="bun" />

import { afterAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { EMPTY_SETTINGS } from "@/app/constants.ts";
import { useSettingsUIStore } from "@/stores/settingsUIStore.ts";
import { getAppCopy, getAppLocale, setAppCopyLanguage } from "@/app/copy.ts";
import { SettingsShell, repeatsSettingsCopy } from "@/butler-ds";
import { SettingsDetailContent } from "./SettingsDetailContent";
import { createSettingsSections, settingsPageSchema } from "./settingsSections";

const initialLocale = getAppLocale();
const initialDraft = useSettingsUIStore.getState().draft;
// Pages render their fields once a settings draft is loaded.
useSettingsUIStore.setState({ draft: { ...EMPTY_SETTINGS } });
afterAll(() => {
  setAppCopyLanguage(initialLocale);
  useSettingsUIStore.setState({ draft: initialDraft });
});

type Header = { title: string | null; description: string | null };

/**
 * Client render (settings pages read the zustand draft, which a server
 * render would see as the empty initial state). Page effects that fetch are
 * stubbed to never resolve.
 */
async function renderMarkup(node: React.ReactNode): Promise<string> {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const requestAnimationFrame = (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0);
  const cancelAnimationFrame = (handle: number) => clearTimeout(handle);
  class ResizeObserver { observe() {} unobserve() {} disconnect() {} }
  const matchMedia = (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  });
  Object.assign(dom.window, { requestAnimationFrame, cancelAnimationFrame, ResizeObserver, matchMedia });
  const globals: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
    Event: dom.window.Event, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame, cancelAnimationFrame, ResizeObserver, matchMedia,
    fetch: () => new Promise<Response>(() => undefined), IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.assign(globalThis, globals);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(node));
    return dom.window.document.getElementById("root")!.innerHTML;
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
}

function sectionHeaders(markup: string): Header[] {
  const document = new JSDOM(markup).window.document;
  return Array.from(document.querySelectorAll('[data-slot="form-section-header"]')).map((header) => ({
    title: header.querySelector("h3")?.textContent ?? null,
    description: header.querySelector("p")?.textContent ?? null,
  }));
}

/**
 * Every settings page, as SettingsView composes it (the page title and
 * description in the header, the page content in the shell), in both app
 * locales: no section header may repeat the page title or description.
 */
for (const [locale, language] of [["en-US", "en"], ["ko-KR", "ko"]] as const) {
  test(`no settings section header repeats its page title or description (${locale})`, async () => {
    setAppCopyLanguage(language);
    const sections = createSettingsSections(getAppCopy(locale).settings, true);
    expect(sections.length).toBeGreaterThan(10);
    for (const page of sections) {
      const detail = <SettingsDetailContent activeSection={page.id} developerModeEnabled />;
      const composed = await renderMarkup(
        <SettingsShell sidebar={null} pageTitle={page.label} pageDescription={page.description} detail={detail} />,
      );
      // The product copy itself must not repeat the page either: the DS
      // suppression is a safety net, not the way pages drop their header.
      const bare = await renderMarkup(detail);
      expect(sectionHeaders(bare).length + (bare.match(/data-slot="form-section"/gu)?.length ?? 0), page.id).toBeGreaterThan(0);
      for (const header of [...sectionHeaders(composed), ...sectionHeaders(bare)]) {
        if (header.title) {
          expect(repeatsSettingsCopy(header.title, page.label), `${page.id} title "${header.title}"`).toBe(false);
        }
        if (header.description && page.description) {
          expect(
            repeatsSettingsCopy(header.description, page.description),
            `${page.id} description "${header.description}"`,
          ).toBe(false);
        }
      }
    }
  });
}

test("single-list pages render one section without a title that restates the page", async () => {
  setAppCopyLanguage("en");
  for (const id of ["mcp", "skills", "logs", "updates", "system", "archives"] as const) {
    const markup = await renderMarkup(<SettingsDetailContent activeSection={id} developerModeEnabled />);
    const document = new JSDOM(markup).window.document;
    expect(document.querySelectorAll('[data-slot="form-section"]'), id).toHaveLength(1);
    expect(document.querySelector('[data-slot="form-section-header"] h3'), id).toBeNull();
  }
});

/**
 * The declarative schema is the page structure: every page renders its
 * sections in order (optional ones may be absent), every settings field sits
 * inside a section, and every field renders in the one section declaring it.
 */
for (const [locale, language] of [["en-US", "en"], ["ko-KR", "ko"]] as const) {
  test(`settings pages match settingsPageSchema (${locale})`, async () => {
    setAppCopyLanguage(language);
    const declared = new Map<string, string>();
    for (const [page, sections] of Object.entries(settingsPageSchema)) {
      for (const section of sections) {
        for (const field of section.fields) {
          const key = `${page}:${field}`;
          expect(declared.has(key), `${key} declared twice`).toBe(false);
          declared.set(key, section.id);
        }
      }
    }
    for (const page of createSettingsSections(getAppCopy(locale).settings, true)) {
      const schema = settingsPageSchema[page.id];
      const markup = await renderMarkup(<SettingsDetailContent activeSection={page.id} developerModeEnabled />);
      const document = new JSDOM(markup).window.document;
      const rendered = Array.from(document.querySelectorAll("[data-settings-section-id]"))
        .map((section) => section.getAttribute("data-settings-section-id"));
      expect(rendered, page.id).toEqual(schema.map((section) => section.id).filter((id) => rendered.includes(id)));
      expect(rendered, page.id).toEqual(expect.arrayContaining(schema.filter((section) => !section.optional).map((section) => section.id)));
      for (const section of document.querySelectorAll("[data-settings-section-id]")) {
        const declaredKind = schema.find((item) => item.id === section.getAttribute("data-settings-section-id"))?.kind;
        expect(section.getAttribute("data-kind"), `${page.id} kind`).toBe(declaredKind ?? "missing");
      }
      for (const field of document.querySelectorAll("[data-settings-field], [data-setting-id]")) {
        const owner = field.closest("[data-settings-section-id]");
        expect(owner, `${page.id}: a settings field outside a section`).not.toBeNull();
        const settingId = field.getAttribute("data-setting-id");
        expect(settingId, `${page.id}: a settings field without a setting id`).toBeTruthy();
        expect(declared.get(`${page.id}:${settingId}`), `${page.id}:${settingId}`).toBe(owner?.getAttribute("data-settings-section-id") ?? "none");
      }
    }
  });
}
