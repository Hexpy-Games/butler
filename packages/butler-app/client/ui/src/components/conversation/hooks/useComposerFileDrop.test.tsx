/// <reference types="bun" />

import { afterEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { useComposerFileDrop } from "./useComposerFileDrop";

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { navigator?: unknown }).navigator;
  delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  delete (globalThis as { Node?: unknown }).Node;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown })
    .IS_REACT_ACT_ENVIRONMENT;
});

test("file drops prevent navigation, expose feedback, and upload once", async () => {
  const dom = installDom();
  const container = dom.window.document.querySelector("#root");
  if (!(container instanceof dom.window.HTMLElement)) {
    throw new Error("Missing test root.");
  }
  const onFiles = mock<(files: FileList) => void>();
  const root = createRoot(container);

  await act(async () => root.render(<DropHarness onFiles={onFiles} />));
  const target = container.querySelector("[data-drop-target]");
  if (!(target instanceof dom.window.HTMLElement)) {
    throw new Error("Missing drop target.");
  }
  const files = fileList(dom, "notes.txt", "text/plain");
  let enter: ReturnType<typeof dispatchDrag> | undefined;
  await act(async () => {
    enter = dispatchDrag(target, dom.window, "dragenter", files, ["Files"]);
  });
  expect(container.querySelector("[data-drop-active]")).not.toBeNull();
  if (!enter) throw new Error("Missing dragenter event.");
  expect(enter.defaultPrevented).toBe(true);

  let leave: ReturnType<typeof dispatchDrag> | undefined;
  await act(async () => {
    leave = dispatchDrag(target, dom.window, "dragleave", files, ["Files"]);
  });
  if (!leave) throw new Error("Missing dragleave event.");
  expect(leave.defaultPrevented).toBe(true);
  expect(container.querySelector("[data-drop-active]")).toBeNull();

  await act(async () => {
    dispatchDrag(target, dom.window, "dragenter", files, ["Files"]);
  });
  let drop: ReturnType<typeof dispatchDrag> | undefined;
  await act(async () => {
    drop = dispatchDrag(target, dom.window, "drop", files, ["Files"]);
  });
  if (!drop) throw new Error("Missing drop event.");
  expect(drop.defaultPrevented).toBe(true);
  expect(onFiles).toHaveBeenCalledTimes(1);
  expect(onFiles.mock.calls[0]?.[0]).toBe(files);
  expect(container.querySelector("[data-drop-active]")).toBeNull();
  await act(async () => root.unmount());
});

test("non-file drags are ignored and do not prevent navigation", async () => {
  const dom = installDom();
  const container = dom.window.document.querySelector("#root");
  if (!(container instanceof dom.window.HTMLElement)) {
    throw new Error("Missing test root.");
  }
  const onFiles = mock<(files: FileList) => void>();
  const root = createRoot(container);

  await act(async () => root.render(<DropHarness onFiles={onFiles} />));
  const target = container.querySelector("[data-drop-target]");
  if (!(target instanceof dom.window.HTMLElement)) {
    throw new Error("Missing drop target.");
  }
  const files = emptyFileList();
  let enter: ReturnType<typeof dispatchDrag> | undefined;
  await act(async () => {
    enter = dispatchDrag(
      target,
      dom.window,
      "dragenter",
      files,
      ["text/uri-list"],
    );
  });
  let drop: ReturnType<typeof dispatchDrag> | undefined;
  await act(async () => {
    drop = dispatchDrag(
      target,
      dom.window,
      "drop",
      files,
      ["text/uri-list"],
    );
  });
  if (!enter || !drop) throw new Error("Missing drag events.");
  expect(enter.defaultPrevented).toBe(false);
  expect(drop.defaultPrevented).toBe(false);
  expect(onFiles).not.toHaveBeenCalled();
  expect(container.querySelector("[data-drop-active]")).toBeNull();
  await act(async () => root.unmount());
});

function DropHarness({ onFiles }: { onFiles: (files: FileList) => void }) {
  const drop = useComposerFileDrop(onFiles);
  return (
    <form
      data-drop-target
      data-drop-active={drop.dropActive ? "true" : undefined}
      onDragEnter={drop.onDragEnter}
      onDragLeave={drop.onDragLeave}
      onDragOver={drop.onDragOver}
      onDrop={drop.onDrop}
    />
  );
}

function dispatchDrag(
  target: Element,
  window: JSDOM["window"],
  type: string,
  files: FileList,
  types: string[],
) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    configurable: true,
    value: { dropEffect: "none", files, types },
  });
  target.dispatchEvent(event);
  return event;
}

function fileList(dom: JSDOM, name: string, type: string): FileList {
  const file = new dom.window.File(["file"], name, { type });
  return {
    0: file,
    length: 1,
    item: (index: number) => (index === 0 ? file : null),
  } as unknown as FileList;
}

function emptyFileList(): FileList {
  return {
    length: 0,
    item: () => null,
  } as unknown as FileList;
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
