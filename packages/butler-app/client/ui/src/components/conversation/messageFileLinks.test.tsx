/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { MessageFileRef } from "@/app/types.ts";
import { MessageArtifacts } from "./MessageArtifacts";
import { MessageAttachments } from "./MessageAttachments";

const PATH = "/message-files/file-11111111-1111-4111-8111-111111111111";
const SIGNED = `${PATH}?expires=1900000000&signature=${"s".repeat(43)}`;

afterEach(() => {
  for (const name of ["window", "document", "navigator", "HTMLElement", "Node", "IS_REACT_ACT_ENVIRONMENT"]) {
    delete (globalThis as Record<string, unknown>)[name];
  }
});

test("message attachment links open the signed URL", async () => {
  const dom = installDom();
  const container = dom.window.document.querySelector("#root")!;
  const root = createRoot(container);
  await act(async () => root.render(<MessageAttachments attachments={[attachment()]} />));

  expect(container.querySelector("a")?.getAttribute("href")).toBe(SIGNED);
  await act(async () => root.unmount());
});

test("attachment-backed artifact cards keep the signed URL for browser saves", async () => {
  const dom = installDom();
  const container = dom.window.document.querySelector("#root")!;
  const root = createRoot(container);
  await act(async () => root.render(<MessageArtifacts artifacts={[]} attachments={[attachment()]} />));

  expect(container.querySelector("a[download]")?.getAttribute("href")).toBe(SIGNED);
  await act(async () => root.unmount());
});

function attachment(): MessageFileRef {
  return {
    file_id: "file-11111111-1111-4111-8111-111111111111",
    kind: "text",
    mime_type: "text/plain",
    safe_name: "notes.txt",
    size_bytes: 10,
    sha256: "a".repeat(64),
    url: PATH,
    signed_url: SIGNED,
    created_at: "2026-09-28T00:00:00.000Z",
  };
}

function installDom() {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://127.0.0.1:18765/" });
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
