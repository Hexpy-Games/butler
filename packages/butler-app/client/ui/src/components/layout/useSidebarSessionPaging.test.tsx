/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { appCopy } from "@/app/copy.ts";
import { NavRow } from "@/butler-ds";
import { SidebarSessionLoadMore } from "./SidebarSessionLoadMore";
import { useSidebarSessionPaging } from "./useSidebarSessionPaging";

interface Item {
  id: string;
  label: string;
}

afterEach(() => {
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Node",
    "IS_REACT_ACT_ENVIRONMENT",
  ]) delete (globalThis as Record<string, unknown>)[key];
});

test("reveals five sessions at a time and keeps paging independent per instance", async () => {
  const { container, root } = await render(
    <div>
      <PagingHarness items={items(12)} label="chats" />
      <PagingHarness items={items(6)} label="project" />
    </div>,
  );
  expect(labels(container, "chats")).toHaveLength(5);
  expect(labels(container, "project")).toHaveLength(5);
  const chatsMore = button(container, "chats");
  expect(chatsMore.textContent).toContain("7");
  expect(button(container, "project").textContent).toContain("1");
  expect(chatsMore.querySelector('[data-slot="nav-row-label"]')?.textContent)
    .toBe(`${appCopy.common.more} (7)`);
  expect(chatsMore.getAttribute("role")).toBe("button");
  expect(chatsMore.className).toBe(
    container.querySelector('[data-test-class="chats-session-row"]')?.className ?? "",
  );
  expect(chatsMore.querySelector('[data-slot="nav-row-label"]')?.className).toBe(
    container.querySelector(
      '[data-test-class="chats-session-row"] [data-slot="nav-row-label"]',
    )?.className ?? "",
  );

  await act(async () => chatsMore.click());
  expect(labels(container, "chats")).toHaveLength(10);
  expect(labels(container, "project")).toHaveLength(5);
  expect(button(container, "chats").textContent).toContain("2");
  await act(async () => button(container, "chats").click());
  expect(labels(container, "chats")).toHaveLength(12);
  expect(container.querySelector('[data-test="more-chats"]')).toBeNull();
  await act(async () => root.unmount());
});

test("keeps an already visible active session visible after navigation refresh", async () => {
  const first = items(6);
  const { container, root } = await render(
    <PagingHarness activeId="session-1" items={first} label="chats" />,
  );
  expect(labels(container, "chats")).toContain("Session 1");
  const refreshed = [
    ...items(9).map((item) => ({ ...item, id: `new-${item.id}` })),
    ...first,
  ];
  await act(async () =>
    root.render(
      <PagingHarness activeId="session-1" items={refreshed} label="chats" />,
    ),
  );
  expect(labels(container, "chats")).toContain("Session 1");
  expect(labels(container, "chats")).toHaveLength(11);
  await act(async () => button(container, "chats").click());
  expect(labels(container, "chats")).toHaveLength(15);
  expect(container.querySelector('[data-test="more-chats"]')).toBeNull();
  await act(async () => root.unmount());
});

function PagingHarness({
  activeId,
  items: sessions,
  label,
}: {
  activeId?: string;
  items: Item[];
  label: string;
}) {
  const paging = useSidebarSessionPaging(sessions, activeId);
  return (
    <section data-test={label}>
      <div data-test={`${label}-items`}>
        {paging.visibleSessions.map((item) => (
          <NavRow
            key={item.id}
            dataTestClass={`${label}-session-row`}
            label={item.label}
            onClick={() => undefined}
          />
        ))}
      </div>
      {paging.remainingCount > 0 ? (
        <div data-test={`more-${label}`}>
          <SidebarSessionLoadMore
            onClick={paging.showMore}
            remainingCount={paging.remainingCount}
          />
        </div>
      ) : null}
    </section>
  );
}

function labels(container: Element, label: string) {
  return Array.from(
    container.querySelectorAll(
      `[data-test="${label}-items"] [data-slot="nav-row-label"]`,
    ),
  ).map((element) => element.textContent ?? "");
}

function button(container: Element, label: string): HTMLElement {
  const row = container
    .querySelector(`[data-test="more-${label}"]`)
    ?.querySelector('[data-test-class="sidebar-load-more"]');
  if (!(row instanceof HTMLElement)) throw new Error(`Missing more row: ${label}`);
  return row;
}

function items(count: number): Item[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `session-${index}`,
    label: `Session ${index}`,
  }));
}

async function render(
  children: React.ReactNode,
): Promise<{ container: HTMLElement; root: Root }> {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const container = dom.window.document.querySelector("#root");
  if (!(container instanceof dom.window.HTMLElement)) throw new Error("Missing root");
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(container);
  await act(async () => root.render(children));
  return { container, root };
}
