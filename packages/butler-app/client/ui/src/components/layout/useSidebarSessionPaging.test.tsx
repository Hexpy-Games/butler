/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { useSidebarSessionPaging } from "./useSidebarSessionPaging";
interface Item {
  id: string;
  label: string;
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { navigator?: unknown }).navigator;
  delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  delete (globalThis as { Node?: unknown }).Node;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown })
    .IS_REACT_ACT_ENVIRONMENT;
});
test("reveals five sessions at a time and keeps paging independent per instance", async () => {
  const dom = installDom();
  const container = dom.window.document.querySelector("#root");
  if (!(container instanceof dom.window.HTMLElement)) {
    throw new Error("Missing test root.");
  }
  const root = createRoot(container);
  const chats = items(12);
  const project = items(6);
  await act(async () => {
    root.render(
      <div>
        <PagingHarness items={chats} label="chats" />
        <PagingHarness items={project} label="project" />
      </div>,
    );
  });

  expect(labels(container, "chats")).toHaveLength(5);
  expect(labels(container, "project")).toHaveLength(5);
  expect(button(container, "chats").textContent).toContain("7");
  expect(button(container, "project").textContent).toContain("1");

  await act(async () => button(container, "chats").click());
  expect(labels(container, "chats")).toHaveLength(10);
  expect(labels(container, "project")).toHaveLength(5);
  expect(button(container, "chats").textContent).toContain("2");

  await act(async () => button(container, "chats").click());
  expect(labels(container, "chats")).toHaveLength(12);
  expect(container.querySelector('[data-test="more-chats"]')).toBeNull();
  await act(async () => root.unmount());
});
test("keeps an already visible active session visible after navigation refresh", async () => {
  const dom = installDom();
  const container = dom.window.document.querySelector("#root");
  if (!(container instanceof dom.window.HTMLElement)) {
    throw new Error("Missing test root.");
  }
  const root = createRoot(container);
  const first = items(6);

  await act(async () => {
    root.render(
      <PagingHarness activeId="session-1" items={first} label="chats" />,
    );
  });
  expect(labels(container, "chats")).toContain("Session 1");

  await act(async () => {
    root.render(
      <PagingHarness
        activeId="session-1"
        items={[
          { id: "new-0", label: "New 0" },
          { id: "new-1", label: "New 1" },
          { id: "new-2", label: "New 2" },
          { id: "new-3", label: "New 3" },
          { id: "new-4", label: "New 4" },
          { id: "new-5", label: "New 5" },
          { id: "new-6", label: "New 6" },
          { id: "new-7", label: "New 7" },
          { id: "new-8", label: "New 8" },
          ...first,
        ]}
        label="chats"
      />,
    );
  });
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
          <span key={item.id}>{item.label}</span>
        ))}
      </div>
      {paging.remainingCount > 0 ? (
        <button data-test={`more-${label}`} onClick={paging.showMore} type="button">
          More {paging.remainingCount}
        </button>
      ) : null}
    </section>
  );
}

function labels(container: Element, label: string) {
  return Array.from(
    container.querySelectorAll(`[data-test="${label}-items"] span`),
  ).map((element) => element.textContent ?? "");
}

function button(container: Element, label: string): HTMLButtonElement {
  const element = container.querySelector(`[data-test="more-${label}"]`);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Missing more button for ${label}.`);
  }
  return element as HTMLButtonElement;
}

function items(count: number): Item[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `session-${index}`,
    label: `Session ${index}`,
  }));
}

function installDom() {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://localhost",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  return dom;
}
