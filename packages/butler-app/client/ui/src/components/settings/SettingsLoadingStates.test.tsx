/// <reference types="bun" />

import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { appCopy } from "@/app/copy.ts";
import { ArchivesSettings } from "./ArchivesSettings";
import { McpSettings } from "./McpSettings";
import { SkillsSettings } from "./SkillsSettings";
import { AboutSettings } from "./AboutSettings";
import { SystemEventsSettings } from "./SystemEventsSettings";
import { UpdatesSettings } from "./UpdatesSettings";
import { UsageSettings } from "./UsageSettings";

const skeleton = 'data-slot="settings-section-skeleton"';

test("archives show a skeleton, not the empty message, before the first load", () => {
  const html = renderToStaticMarkup(<ArchivesSettings />);
  expect(html).toContain(skeleton);
  expect(html).not.toContain(appCopy.interfaceDetails.archivesEmpty);
});

test("skills show a skeleton, not empty groups, before the first load", () => {
  const html = renderToStaticMarkup(<SkillsSettings />);
  expect(html).toContain(skeleton);
  expect(html).not.toContain(appCopy.interfaceDetails.noSkills);
});

test("MCP servers show a skeleton, not the empty message, before the first load", () => {
  const html = renderToStaticMarkup(<McpSettings />);
  expect(html).toContain(skeleton);
  expect(html).not.toContain(appCopy.interfaceDetails.noMcp);
});

/** Client render with every fetch failing; returns the markup once the rejections settle. */
async function renderWithFailingFetch(node: React.ReactNode): Promise<string> {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const matchMedia = (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  });
  class ResizeObserver { observe() {} unobserve() {} disconnect() {} }
  Object.assign(dom.window, { matchMedia, ResizeObserver });
  const globals: Record<string, unknown> = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    Element: dom.window.Element, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node,
    Event: dom.window.Event, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    matchMedia, ResizeObserver,
    fetch: () => Promise.reject(new Error("offline")), IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.assign(globalThis, globals);
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => root.render(node));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    return dom.window.document.getElementById("root")!.innerHTML;
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
}

test("settings sections that fetch show an error with Retry when the fetch fails", async () => {
  const pages = { ArchivesSettings, McpSettings, SkillsSettings, UpdatesSettings, SystemEventsSettings, UsageSettings, AboutSettings };
  for (const [name, Page] of Object.entries(pages)) {
    const html = await renderWithFailingFetch(<Page />);
    expect(html, name).toContain('data-slot="settings-section-error"');
    expect(html, name).toContain(`>${appCopy.settings.sectionState.retry}</button>`);
    expect(html, name).not.toContain(skeleton);
  }
});
