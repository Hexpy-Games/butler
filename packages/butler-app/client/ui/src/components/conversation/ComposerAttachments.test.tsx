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

  expect(html).toContain('data-slot="attachment-thumbnail"');
  expect(html).toContain(`src="${IMAGE_URL}"`);
  expect(html).toContain('alt="screenshot.png"');
  expect(html).toContain('data-slot="attachment-icon"');
  expect(
    Array.from(container.querySelectorAll('[data-slot="attachment-name"]')).map(
      (element) => element.textContent,
    ),
  ).toContain("notes.md");
  expect(html).not.toContain(`src="${GENERIC_URL}"`);
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
