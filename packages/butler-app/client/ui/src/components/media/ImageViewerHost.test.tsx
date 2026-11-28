// test-category: pure-logic
import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { getAppLocale, setAppCopyLanguage } from "@/app/copy";
import { ImageViewerHost } from "./ImageViewerHost";
import { openImageViewer, useImageViewerState, type ViewerImage } from "./imageViewerState";

test("shows 편집 for a message-file image only with a session", async () => {
  const { window } = new JSDOM("<div id='root'></div>", { pretendToBeVisual: true });
  const globals = {
    window, document: window.document, HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement,
    Node: window.Node, NodeFilter: window.NodeFilter, CustomEvent: window.CustomEvent, MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window), IS_REACT_ACT_ENVIRONMENT: true,
  };
  const descriptors = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const previous = useImageViewerState.getState();
  const locale = getAppLocale();
  Object.assign(globalThis, globals);
  const root = createRoot(document.getElementById("root")!);
  const image: ViewerImage = { src: "data:,", alt: "Picture", kind: "image", fileId: "file-1", sessionId: "chat-1" };
  try {
    setAppCopyLanguage("ko-KR");
    await act(async () => {
      openImageViewer([image], 0);
      root.render(<ImageViewerHost />);
    });
    expect(document.querySelector('button[aria-label="편집"]')).not.toBeNull();
    await act(async () => openImageViewer([{ ...image, kind: "video" }], 0));
    expect(document.querySelector('button[aria-label="편집"]')).toBeNull();
    await act(async () => openImageViewer([{ ...image, sessionId: undefined }], 0));
    expect(document.querySelector('button[aria-label="편집"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    // Radix restores dialog focus in a queued timer after unmount.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    useImageViewerState.setState(previous);
    setAppCopyLanguage(locale);
    window.close();
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
