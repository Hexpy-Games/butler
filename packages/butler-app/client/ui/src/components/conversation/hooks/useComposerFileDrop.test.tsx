/// <reference types="bun" />

import { afterEach, expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { MessageFileRef } from "@/app/types.ts";
import { useComposerFileDrop } from "./useComposerFileDrop";

const uploadMessageFileMock = mock(
  async (input: {
    bytes: ArrayBuffer;
    mimeType: string;
    name: string;
  }): Promise<{ file: MessageFileRef }> => ({
    file: {
      created_at: "2026-08-05T00:00:00.000Z",
      file_id: "file-uploaded",
      kind: "generic",
      mime_type: input.mimeType,
      safe_name: input.name,
      sha256: "a".repeat(64),
      size_bytes: input.bytes.byteLength,
      url: "/message-files/file-uploaded",
    },
  }),
);

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { navigator?: unknown }).navigator;
  delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  delete (globalThis as { Node?: unknown }).Node;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown })
    .IS_REACT_ACT_ENVIRONMENT;
});

test("capture-level file drops prevent navigation, expose feedback, and upload once", async () => {
  const dom = installDom();
  const container = dom.window.document.querySelector("#root");
  if (!(container instanceof dom.window.HTMLElement)) {
    throw new Error("Missing test root.");
  }
  const onFiles = mock<(files: FileList) => void>();
  const root = createRoot(container);

  await act(async () => root.render(<DropHarness onFiles={onFiles} />));
  const outside = dom.window.document.querySelector("[data-drop-outside]");
  if (!(outside instanceof dom.window.HTMLElement)) {
    throw new Error("Missing outside drop target.");
  }
  const files = fileList(dom, "notes.txt", "text/plain");
  let enter: ReturnType<typeof dispatchDrag> | undefined;
  await act(async () => {
    enter = dispatchDrag(outside, dom.window, "dragenter", files, ["Files"]);
  });
  expect(container.querySelector("[data-drop-active]")).not.toBeNull();
  if (!enter) throw new Error("Missing dragenter event.");
  expect(enter.defaultPrevented).toBe(true);
  expect(enter.dataTransfer.dropEffect).toBe("copy");

  const over = dispatchDrag(outside, dom.window, "dragover", files, ["Files"]);
  expect(over.defaultPrevented).toBe(true);
  expect(over.dataTransfer.dropEffect).toBe("copy");

  let leave: ReturnType<typeof dispatchDrag> | undefined;
  await act(async () => {
    leave = dispatchDrag(outside, dom.window, "dragleave", files, ["Files"]);
  });
  if (!leave) throw new Error("Missing dragleave event.");
  expect(leave.defaultPrevented).toBe(true);
  expect(container.querySelector("[data-drop-active]")).toBeNull();

  await act(async () => {
    dispatchDrag(outside, dom.window, "dragenter", files, ["Files"]);
  });
  let drop: ReturnType<typeof dispatchDrag> | undefined;
  await act(async () => {
    drop = dispatchDrag(outside, dom.window, "drop", files, ["Files"]);
  });
  if (!drop) throw new Error("Missing drop event.");
  expect(drop.defaultPrevented).toBe(true);
  expect(onFiles).toHaveBeenCalledTimes(1);
  expect(onFiles.mock.calls[0]?.[0]).toBe(files);
  expect(container.querySelector("[data-drop-active]")).toBeNull();
  await act(async () => root.unmount());
});

test("empty file-typed drops block navigation without uploading", async () => {
  const dom = installDom();
  const container = dom.window.document.querySelector("#root");
  if (!(container instanceof dom.window.HTMLElement)) {
    throw new Error("Missing test root.");
  }
  const onFiles = mock<(files: FileList) => void>();
  const root = createRoot(container);
  await act(async () => root.render(<DropHarness onFiles={onFiles} />));
  const outside = dom.window.document.querySelector("[data-drop-outside]");
  if (!(outside instanceof dom.window.HTMLElement)) {
    throw new Error("Missing outside drop target.");
  }
  let drop: ReturnType<typeof dispatchDrag> | undefined;
  await act(async () => {
    drop = dispatchDrag(
      outside,
      dom.window,
      "drop",
      emptyFileList(),
      ["Files"],
    );
  });
  if (!drop) throw new Error("Missing drop event.");
  expect(drop.defaultPrevented).toBe(true);
  expect(onFiles).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

test("malformed file-typed drops block navigation without throwing or uploading", async () => {
  const dom = installDom();
  const container = dom.window.document.querySelector("#root");
  if (!(container instanceof dom.window.HTMLElement)) {
    throw new Error("Missing test root.");
  }
  const onFiles = mock<(files: FileList) => void>();
  const root = createRoot(container);
  await act(async () => root.render(<DropHarness onFiles={onFiles} />));
  const outside = dom.window.document.querySelector("[data-drop-outside]");
  if (!(outside instanceof dom.window.HTMLElement)) {
    throw new Error("Missing outside drop target.");
  }
  const drop = dispatchDrag(outside, dom.window, "drop", undefined, ["Files"]);
  expect(drop.defaultPrevented).toBe(true);
  expect(onFiles).not.toHaveBeenCalled();
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
  const outside = dom.window.document.querySelector("[data-drop-outside]");
  if (!(outside instanceof dom.window.HTMLElement)) {
    throw new Error("Missing outside drop target.");
  }
  const files = emptyFileList();
  let enter: ReturnType<typeof dispatchDrag> | undefined;
  await act(async () => {
    enter = dispatchDrag(
      outside,
      dom.window,
      "dragenter",
      files,
      ["text/uri-list"],
    );
  });
  const over = dispatchDrag(
    outside,
    dom.window,
    "dragover",
    files,
    ["text/uri-list"],
  );
  let drop: ReturnType<typeof dispatchDrag> | undefined;
  await act(async () => {
    drop = dispatchDrag(
      outside,
      dom.window,
      "drop",
      files,
      ["text/uri-list"],
    );
  });
  if (!enter || !drop) throw new Error("Missing drag events.");
  expect(enter.defaultPrevented).toBe(false);
  expect(over.defaultPrevented).toBe(false);
  expect(over.dataTransfer.dropEffect).toBe("none");
  expect(drop.defaultPrevented).toBe(false);
  expect(onFiles).not.toHaveBeenCalled();
  expect(container.querySelector("[data-drop-active]")).toBeNull();
  await act(async () => root.unmount());
});

test("unmount removes capture listeners and resets feedback", async () => {
  const dom = installDom();
  const container = dom.window.document.querySelector("#root");
  if (!(container instanceof dom.window.HTMLElement)) {
    throw new Error("Missing test root.");
  }
  const onFiles = mock<(files: FileList) => void>();
  const root = createRoot(container);
  await act(async () => root.render(<DropHarness onFiles={onFiles} />));
  const outside = dom.window.document.querySelector("[data-drop-outside]");
  if (!(outside instanceof dom.window.HTMLElement)) {
    throw new Error("Missing outside drop target.");
  }
  const files = fileList(dom, "notes.txt", "text/plain");
  await act(async () => {
    dispatchDrag(outside, dom.window, "dragenter", files, ["Files"]);
  });
  expect(container.querySelector("[data-drop-active]")).not.toBeNull();
  await act(async () => root.unmount());
  const drop = dispatchDrag(outside, dom.window, "drop", files, ["Files"]);
  expect(drop.defaultPrevented).toBe(false);
  expect(onFiles).not.toHaveBeenCalled();
});

test("window capture drop reaches the attachment upload boundary once", async () => {
  const { useFileAttachments } = await import("./useFileAttachments");
  const dom = installDom();
  const container = dom.window.document.querySelector("#root");
  if (!(container instanceof dom.window.HTMLElement)) {
    throw new Error("Missing test root.");
  }
  uploadMessageFileMock.mockClear();
  dom.window.butlerApp = {
    uploadMessageFile: async (input: unknown) => {
      const payload = input as {
        bytes: ArrayBuffer;
        mimeType: string;
        name: string;
      };
      return await uploadMessageFileMock({
        mimeType: payload.mimeType,
        name: payload.name,
        bytes: payload.bytes,
      });
    },
  };
  const root = createRoot(container);

  await act(async () => {
    root.render(<AttachmentDropHarness useFileAttachments={useFileAttachments} />);
  });
  const outside = dom.window.document.querySelector("[data-drop-outside]");
  if (!(outside instanceof dom.window.HTMLElement)) {
    throw new Error("Missing outside drop target.");
  }
  const files = fileList(dom, "notes.txt", "text/plain");
  await act(async () => {
    dispatchDrag(outside, dom.window, "dragenter", files, ["Files"]);
    dispatchDrag(outside, dom.window, "drop", files, ["Files"]);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(uploadMessageFileMock).toHaveBeenCalledTimes(1);
  const uploadInput = uploadMessageFileMock.mock.calls[0]?.[0];
  expect(uploadInput?.name).toBe("notes.txt");
  expect(uploadInput?.mimeType).toBe("text/plain");
  expect(uploadInput?.bytes.byteLength).toBe(4);
  expect(container.querySelector("[data-uploaded-count]")?.textContent).toBe(
    "1",
  );
  await act(async () => root.unmount());
});

function DropHarness({ onFiles }: { onFiles: (files: FileList) => void }) {
  const drop = useComposerFileDrop(onFiles);
  return (
    <>
      <form
        data-drop-target
        data-drop-active={drop.dropActive ? "true" : undefined}
      />
      <div data-drop-outside />
    </>
  );
}

function AttachmentDropHarness({
  useFileAttachments,
}: {
  useFileAttachments: typeof import("./useFileAttachments").useFileAttachments;
}) {
  const attachments = useFileAttachments("chat-upload-test");
  const drop = useComposerFileDrop((files) => void attachments.addFiles(files));
  return (
    <>
      <form data-drop-active={drop.dropActive ? "true" : undefined} />
      <div data-drop-outside />
      <output data-uploaded-count>{attachments.attachments.length}</output>
    </>
  );
}

function dispatchDrag(
  target: Element,
  window: JSDOM["window"],
  type: string,
  files: FileList | undefined,
  types: string[],
): TestDragEvent {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    configurable: true,
    value: { dropEffect: "none", files, types },
  });
  target.dispatchEvent(event);
  return event as TestDragEvent;
}

type TestDragEvent = Event & {
  dataTransfer: {
    dropEffect: string;
    files?: FileList;
    types: string[];
  };
};

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
