/// <reference types="bun" />

import { afterEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

const store = {
  creatingProject: false,
  createScratchProject: async () => true,
  projectCreateDialogOpen: false,
  setProjectCreateDialogOpen: () => undefined,
};

mock.module("@/app/store.ts", () => ({
  useButlerStore<T>(selector: (state: typeof store) => T): T {
    return selector(store);
  },
}));

afterEach(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown })
    .IS_REACT_ACT_ENVIRONMENT;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { navigator?: unknown }).navigator;
  delete (globalThis as { Element?: unknown }).Element;
  delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  delete (globalThis as { HTMLFormElement?: unknown }).HTMLFormElement;
  delete (globalThis as { HTMLInputElement?: unknown }).HTMLInputElement;
  delete (globalThis as { Node?: unknown }).Node;
  delete (globalThis as { NodeFilter?: unknown }).NodeFilter;
  delete (globalThis as { DocumentFragment?: unknown }).DocumentFragment;
  delete (globalThis as { Event?: unknown }).Event;
  delete (globalThis as { CustomEvent?: unknown }).CustomEvent;
  delete (globalThis as { MouseEvent?: unknown }).MouseEvent;
  delete (globalThis as { KeyboardEvent?: unknown }).KeyboardEvent;
  delete (globalThis as { FocusEvent?: unknown }).FocusEvent;
  delete (globalThis as { MutationObserver?: unknown }).MutationObserver;
  delete (globalThis as { getComputedStyle?: unknown }).getComputedStyle;
  delete (globalThis as { requestAnimationFrame?: unknown })
    .requestAnimationFrame;
  delete (globalThis as { cancelAnimationFrame?: unknown })
    .cancelAnimationFrame;
});

test("project create dialog renders DS form regions without overlap-prone composition", async () => {
  const rendered = await renderDialog();
  const content = rendered.container.querySelector(
    '[data-slot="dialog-content"]',
  );
  if (!(content instanceof HTMLElement)) throw new Error("Missing dialog.");
  expect(content.getAttribute("data-glass")).toBe("popover");
  expect(content.getAttribute("data-radius")).toBe("composer");
  expect(content.getAttribute("data-surface")).toBe("tinted-glass");

  const form = content.querySelector("form");
  if (!(form instanceof HTMLFormElement)) throw new Error("Missing form.");
  expect(form.className).not.toContain("modal-form");
  expect(form.querySelector("input#project-create-input")).not.toBeNull();
  expect(form.querySelector('[data-slot="field"]')).not.toBeNull();
  expect(form.querySelector('[data-slot="field-label"]')).not.toBeNull();
  expect(form.querySelector('[data-slot="button-container"]')).not.toBeNull();
  expect(form.querySelectorAll('[data-slot="button"]')).toHaveLength(2);

  const regions = Array.from(form.children);
  expect(regions).toHaveLength(3);
  expect(regions[0]?.textContent).toContain("Create a project");
  expect(regions[1]?.querySelector("#project-create-input")).not.toBeNull();
  expect(regions[2]?.querySelector('[data-slot="button-container"]')).not.toBeNull();

  await act(async () => rendered.root.unmount());
});

test("generic DS dialogs keep the panel glass radius by default", async () => {
  const rendered = await renderDefaultDialog();
  const content = rendered.container.querySelector(
    '[data-slot="dialog-content"]',
  );
  if (!(content instanceof HTMLElement)) throw new Error("Missing dialog.");
  expect(content.getAttribute("data-radius")).toBe("panel");
  await act(async () => rendered.root.unmount());
});

async function renderDialog() {
  return renderRoot(async () => {
    const { ProjectCreateDialog } = await import("./ProjectCreateDialog");
    return (
      <ProjectCreateDialog
        open
        onOpenChange={() => undefined}
        onSubmit={() => true}
      />
    );
  });
}

async function renderDefaultDialog() {
  return renderRoot(async () => {
    const { Dialog, DialogContent, DialogTitle } = await import("@/butler-ds");
    return (
      <Dialog open>
        <DialogContent aria-describedby={undefined} showCloseButton={false}>
          <DialogTitle>Default dialog</DialogTitle>
        </DialogContent>
      </Dialog>
    );
  });
}

async function renderRoot(createElement: () => Promise<React.ReactElement>) {
  const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>");
  const window = dom.window;
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    window,
    document: window.document,
    navigator: window.navigator,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLFormElement: window.HTMLFormElement,
    HTMLInputElement: window.HTMLInputElement,
    Node: window.Node,
    NodeFilter: window.NodeFilter,
    DocumentFragment: window.DocumentFragment,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    MouseEvent: window.MouseEvent,
    KeyboardEvent: window.KeyboardEvent,
    FocusEvent: window.FocusEvent,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
  });
  Object.assign(window.HTMLElement.prototype, {
    attachEvent: () => undefined,
    detachEvent: () => undefined,
  });
  const container = window.document.getElementById("root");
  if (!container) throw new Error("Missing test root.");
  const root = createRoot(container);
  const element = await createElement();
  await act(async () => {
    root.render(element);
  });
  return { container: window.document.body, root };
}
