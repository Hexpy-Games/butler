// test-category: pure-logic
/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import type { MessageFileRef } from "@/app/types.ts";
import { useComposerStore } from "./composerStore";
import { ComposerAttachments } from "./ComposerAttachments";
import type { ComposerAttachment } from "./hooks/useFileAttachments";

const IMAGE_URL = "/message-files/file-11111111-1111-4111-8111-111111111111";
const GENERIC_URL = "/message-files/file-22222222-2222-4222-8222-222222222222";

afterEach(() => {
  useComposerStore.getState().setSnapshot({ attachments: [] });
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { navigator?: unknown }).navigator;
  delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  delete (globalThis as { Node?: unknown }).Node;
  delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
  delete (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown })
    .IS_REACT_ACT_ENVIRONMENT;
});

test("maps image attachments to safe thumbnails and ordinary files to icons", async () => {
  const dom = installDom();
  const container = dom.window.document.querySelector("#root");
  if (!(container instanceof dom.window.HTMLElement)) {
    throw new Error("Missing test root.");
  }
  useComposerStore.getState().setSnapshot({
    attachments: [
      composerAttachment("image", "screenshot.png", IMAGE_URL, "image"),
      composerAttachment("generic", "notes.md", GENERIC_URL, "generic"),
    ],
  });
  const root = createRoot(container);
  await act(async () => root.render(<ComposerAttachments />));

  const html = container.innerHTML;

  const tiles = Array.from(container.querySelectorAll('[data-slot="attachment-tile"]'));
  expect(tiles.map((tile) => tile.getAttribute("data-kind"))).toEqual(["image", "file"]);
  expect(html).toContain(`src="${IMAGE_URL}"`);
  expect(tiles[1]?.textContent).toContain("notes.md");
  expect(tiles[1]?.textContent).toContain("MD");
  expect(html).not.toContain(`src="${GENERIC_URL}"`);
  await act(async () => root.unmount());
});

test("image thumbnails use the upload's signed URL and open in the app, not as links", async () => {
  const dom = installDom();
  Object.assign(dom.window, { butlerApp: { serverUrl: "http://127.0.0.1:18765" } });
  const container = dom.window.document.querySelector("#root")!;
  const signedUrl = `${IMAGE_URL}?expires=1900000000&signature=${"s".repeat(43)}`;
  const attachment = composerAttachment("image", "screenshot.png", IMAGE_URL, "image");
  useComposerStore.getState().setSnapshot({
    attachments: [{ ...attachment, file: { ...attachment.file, signed_url: signedUrl } }],
  });
  const root = createRoot(container);
  await act(async () => root.render(<ComposerAttachments />));

  const absolute = `http://127.0.0.1:18765${signedUrl}`;
  expect(container.querySelector("img")?.getAttribute("src")).toBe(absolute);
  expect(container.querySelector("a")).toBeNull();
  await act(async () => root.unmount());
});

function composerAttachment(
  id: string,
  safeName: string,
  url: string,
  kind: MessageFileRef["kind"],
): ComposerAttachment {
  return {
    id,
    file: {
      created_at: "2026-08-04T00:00:00.000Z",
      file_id: `file-${id}`,
      kind,
      mime_type: kind === "image" ? "image/png" : "text/markdown",
      safe_name: safeName,
      sha256: "a".repeat(64),
      size_bytes: 4096,
      url,
    },
    kind,
  };
}

function installDom() {
  const dom = new JSDOM('<div id="root"></div>', {
    url: "http://localhost",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    // The composer row tracks its scroll edges per frame.
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  return dom;
}
