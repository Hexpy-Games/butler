/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EMPTY_SETTINGS } from "@/app/constants.ts";
import { appCopy } from "@/app/copy.ts";
import { useButlerStore } from "@/app/store.ts";
import { useComposerStore } from "./composerStore";
import type { ComposerAttachment } from "./hooks/useFileAttachments";
import { ComposerStateIndicator } from "./ComposerStateIndicator";

const initialButlerState = useButlerStore.getState();
const initialComposerState = useComposerStore.getState();
let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  useButlerStore.setState(initialButlerState);
  useComposerStore.setState(initialComposerState);
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { navigator?: unknown }).navigator;
  delete (globalThis as { Element?: unknown }).Element;
  delete (globalThis as { HTMLElement?: unknown }).HTMLElement;
  delete (globalThis as { Node?: unknown }).Node;
  delete (globalThis as { MutationObserver?: unknown }).MutationObserver;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown })
    .IS_REACT_ACT_ENVIRONMENT;
});

test("reflects response mode, attachments, and the configured shortcut", async () => {
  const dom = installDom();
  useButlerStore.setState({
    settings: {
      ...EMPTY_SETTINGS,
      multiline_send_behavior: "modifier_enter_send_enter_newline",
    },
  });
  useComposerStore.getState().setSnapshot({ planMode: false, attachments: [] });

  const container = dom.window.document.querySelector("#root");
  if (!(container instanceof dom.window.HTMLElement)) {
    throw new Error("Missing test root.");
  }
  root = createRoot(container);
  await act(async () => root?.render(<ComposerStateIndicator />));

  const normalHtml = container.innerHTML;
  expect(normalHtml).toContain(`>${appCopy.composer.normal}</span>`);
  expect(normalHtml).toContain(
    appCopy.settings.options.modifierEnterSendEnterNewline,
  );
  expect(normalHtml).not.toContain("composer-state-attachments");

  await act(async () => {
    useButlerStore.setState({
      settings: {
        ...EMPTY_SETTINGS,
        multiline_send_behavior: "enter_send_shift_enter_newline",
      },
    });
    useComposerStore.getState().setSnapshot({
      planMode: true,
      attachments: [attachment("one"), attachment("two")],
    });
  });

  const planHtml = container.innerHTML;
  expect(planHtml).toContain(`>${appCopy.composer.plan}</span>`);
  expect(planHtml).toContain(appCopy.composer.attachmentCount(2));
  expect(planHtml).toContain(
    appCopy.settings.options.enterSendShiftEnterNewline,
  );
});

function installDom() {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  return dom;
}

function attachment(id: string): ComposerAttachment {
  return {
    id,
    kind: "text",
    file: {
      file_id: id,
      kind: "text",
      mime_type: "text/plain",
      safe_name: `${id}.txt`,
      size_bytes: 1,
      sha256: "test-sha",
      url: `/files/${id}`,
      created_at: "2026-09-04T00:00:00.000Z",
    },
  };
}
