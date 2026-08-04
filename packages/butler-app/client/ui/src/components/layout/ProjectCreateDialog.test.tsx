/// <reference types="bun" />

import { afterEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

mock.module("@/butler-ds", () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  ButtonContainer: ({ children }: React.PropsWithChildren) => (
    <div>{children}</div>
  ),
  Dialog: ({
    children,
    onOpenChange,
    open,
  }: React.PropsWithChildren<{
    onOpenChange?: (open: boolean) => void;
    open?: boolean;
  }>) =>
    open ? (
      <div
        data-test="dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape") onOpenChange?.(false);
        }}
      >
        <div
          data-test="dialog-overlay"
          onPointerDown={() => onOpenChange?.(false)}
        />
        {children}
      </div>
    ) : null,
  DialogContent: ({ children }: React.PropsWithChildren) => (
    <div>{children}</div>
  ),
  DialogForm: ({
    children,
    footer,
    onSubmit,
    title,
  }: React.PropsWithChildren<{
    footer?: React.ReactNode;
    onSubmit?: () => void;
    title: React.ReactNode;
  }>) => (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit?.();
      }}
    >
      <h2>{title}</h2>
      {children}
      {footer}
    </form>
  ),
  DialogFooter: ({ children }: React.PropsWithChildren) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: React.PropsWithChildren) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
  Field: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  FieldLabel: ({
    children,
    htmlFor,
  }: React.LabelHTMLAttributes<HTMLLabelElement>) => (
    <label htmlFor={htmlFor}>{children}</label>
  ),
  Input: ({
    autoFocus: _autoFocus,
    ...props
  }: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

const { ProjectCreateDialog } = await import("./ProjectCreateDialog");

interface RenderedDialog {
  container: HTMLElement;
  root: Root;
  window: typeof globalThis;
}

afterEach(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown })
    .IS_REACT_ACT_ENVIRONMENT;
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { navigator?: unknown }).navigator;
  delete (globalThis as { Element?: unknown }).Element;
  delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  delete (globalThis as { Node?: unknown }).Node;
  delete (globalThis as { DocumentFragment?: unknown }).DocumentFragment;
});

test("project create dialog keeps Create disabled for empty names and cancels without submit", async () => {
  const submitted: string[] = [];
  const closed: boolean[] = [];
  const rendered = await renderDialog({
    initialDisplayName: "   ",
    onOpenChange: (open) => closed.push(open),
    onSubmit: (name) => {
      submitted.push(name);
    },
  });

  expect(button(rendered.container, "Create")?.disabled).toBe(true);
  expect(button(rendered.container, "Create")?.disabled).toBe(true);
  await click(rendered, "Cancel");
  expect(submitted).toEqual([]);
  expect(closed).toEqual([false]);
  await act(async () => rendered.root.unmount());
});

test("project create dialog trims input and prevents duplicate submission while pending", async () => {
  const submitted: string[] = [];
  const closed: boolean[] = [];
  const deferred = createDeferred<boolean>();
  const rendered = await renderDialog({
    initialDisplayName: "  Alpha  ",
    onOpenChange: (open) => closed.push(open),
    onSubmit: (name) => {
      submitted.push(name);
      return deferred.promise;
    },
  });

  const create = button(rendered.container, "Create");
  if (!create) throw new Error("Missing create button.");
  await act(async () => create.click());
  expect(submitted).toEqual(["Alpha"]);
  expect(create.disabled).toBe(true);
  await act(async () => create.click());
  expect(submitted).toEqual(["Alpha"]);

  deferred.resolve(true);
  await act(async () => await deferred.promise);
  expect(closed).toEqual([false]);
  await act(async () => rendered.root.unmount());
});

test("project create dialog closes on Escape without submitting", async () => {
  const submitted: string[] = [];
  const closed: boolean[] = [];
  const rendered = await renderDialog({
    initialDisplayName: "Alpha",
    onOpenChange: (open) => closed.push(open),
    onSubmit: (name) => {
      submitted.push(name);
    },
  });

  const dialog = rendered.container.querySelector('[data-test="dialog"]');
  if (!dialog) throw new Error("Missing dialog.");
  await act(async () => {
    dialog.dispatchEvent(
      new rendered.window.KeyboardEvent("keydown", {
        bubbles: true,
        key: "Escape",
      }),
    );
  });

  expect(submitted).toEqual([]);
  expect(closed).toEqual([false]);
  await act(async () => rendered.root.unmount());
});

test("project create dialog closes on outside interaction without submitting", async () => {
  const submitted: string[] = [];
  const closed: boolean[] = [];
  const rendered = await renderDialog({
    initialDisplayName: "Alpha",
    onOpenChange: (open) => closed.push(open),
    onSubmit: (name) => {
      submitted.push(name);
    },
  });

  const overlay = rendered.container.querySelector(
    '[data-test="dialog-overlay"]',
  );
  if (!overlay) throw new Error("Missing dialog overlay.");
  await act(async () => {
    overlay.dispatchEvent(
      new rendered.window.MouseEvent("pointerdown", { bubbles: true }),
    );
  });

  expect(submitted).toEqual([]);
  expect(closed).toEqual([false]);
  await act(async () => rendered.root.unmount());
});

async function renderDialog(
  options: Partial<React.ComponentProps<typeof ProjectCreateDialog>> = {},
): Promise<RenderedDialog> {
  const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>");
  const window = dom.window;
  const testWindow = window as unknown as typeof globalThis;
  Object.assign(globalThis, {
    IS_REACT_ACT_ENVIRONMENT: true,
    window,
    document: window.document,
    navigator: window.navigator,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    DocumentFragment: window.DocumentFragment,
  });
  const container = window.document.getElementById("root");
  if (!container) throw new Error("Missing test root.");
  const root = createRoot(container);
  await act(async () => {
    root.render(<ProjectCreateDialog open {...options} />);
  });
  return { container: window.document.body, root, window: testWindow };
}

async function click(rendered: RenderedDialog, label: string): Promise<void> {
  const target = button(rendered.container, label);
  if (!target) throw new Error(`Missing button: ${label}`);
  await act(async () => target.click());
}

function button(
  container: HTMLElement,
  label: string,
): HTMLButtonElement | null {
  return (
    ([...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    ) as HTMLButtonElement | undefined) ?? null
  );
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
