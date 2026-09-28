/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { MessageFileRef } from "@/app/types.ts";
import {
  rememberSignedFileUrls,
  resetMessageFileUrlsForTest,
} from "@/app/messageFileUrls.ts";
import { MessageMarkdown } from "./MessageMarkdown";

const PATH = "/message-files/file-11111111-1111-4111-8111-111111111111";
const ARTIFACT_PATH = "/message-files/file-22222222-2222-4222-8222-222222222222";
const SERVER = "http://127.0.0.1:18765";
const STALE = `${PATH}?expires=1900000000&signature=${"s".repeat(43)}`;
const FRESH = `${PATH}?expires=1900000600&signature=${"f".repeat(43)}`;
const ARTIFACT_SIGNED = `${ARTIFACT_PATH}?expires=1900000000&signature=${"a".repeat(43)}`;

afterEach(() => {
  resetMessageFileUrlsForTest();
  for (const name of ["window", "document", "navigator", "HTMLElement", "Node", "IS_REACT_ACT_ENVIRONMENT"]) {
    delete (globalThis as Record<string, unknown>)[name];
  }
});

test("inline images load through signed URLs and refresh once after a failure", async () => {
  const dom = installDom();
  const container = dom.window.document.querySelector("#root")!;
  const root = createRoot(container);
  const refreshes: string[] = [];
  const refreshFileUrls = async () => {
    refreshes.push("refresh");
    rememberSignedFileUrls({ attachments: [{ url: PATH, signed_url: FRESH }] });
  };

  await act(async () => root.render(
    <MessageMarkdown
      attachments={[imageAttachment()]}
      refreshFileUrls={refreshFileUrls}
      text="![shot](shot.png)"
    />,
  ));
  const image = () => container.querySelector("img")!;
  expect(image().getAttribute("src")).toBe(`${SERVER}${STALE}`);

  await act(async () => { image().dispatchEvent(new dom.window.Event("error")); });
  expect(refreshes).toHaveLength(1);
  expect(image().getAttribute("src")).toBe(`${SERVER}${FRESH}`);

  await act(async () => { image().dispatchEvent(new dom.window.Event("error")); });
  expect(refreshes).toHaveLength(1);
  await act(async () => root.unmount());
});

test("inline message-file paths use the signed URL of a matching artifact", async () => {
  const dom = installDom();
  const container = dom.window.document.querySelector("#root")!;
  const root = createRoot(container);

  await act(async () => root.render(
    <MessageMarkdown
      artifacts={[{
        id: "artifact-1",
        title: "chart.png",
        kind: "image",
        url: ARTIFACT_PATH,
        signed_url: ARTIFACT_SIGNED,
        created_at: "2026-09-28T00:00:00.000Z",
      }]}
      text={`![chart](${ARTIFACT_PATH})`}
    />,
  ));

  expect(container.querySelector("img")?.getAttribute("src")).toBe(`${SERVER}${ARTIFACT_SIGNED}`);
  await act(async () => root.unmount());
});

function imageAttachment(): MessageFileRef {
  return {
    file_id: "file-11111111-1111-4111-8111-111111111111",
    kind: "image",
    mime_type: "image/png",
    safe_name: "shot.png",
    size_bytes: 10,
    sha256: "a".repeat(64),
    url: PATH,
    signed_url: STALE,
    created_at: "2026-09-28T00:00:00.000Z",
  };
}

function installDom() {
  const dom = new JSDOM('<div id="root"></div>', { url: "app://butler/index.html" });
  Object.assign(dom.window, { butlerApp: { serverUrl: SERVER } });
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
