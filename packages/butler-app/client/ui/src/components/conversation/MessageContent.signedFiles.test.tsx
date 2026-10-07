// test-category: security
/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { MessageRecord } from "@/app/types.ts";
import { resetMessageFileUrlsForTest } from "@/app/messageFileUrls.ts";
import { MessageContent } from "./MessageContent";

const PATH = "/message-files/file-11111111-1111-4111-8111-111111111111";
const STALE = `${PATH}?expires=1900000000&signature=${"s".repeat(43)}`;
const FRESH = `${PATH}?expires=1900000600&signature=${"f".repeat(43)}`;
const LATEST = "/session-view?session_id=session-1";
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetMessageFileUrlsForTest();
  for (const name of ["window", "document", "navigator", "HTMLElement", "Node", "IS_REACT_ACT_ENVIRONMENT"]) {
    delete (globalThis as Record<string, unknown>)[name];
  }
});

test("an image in an older paged-in message refetches its page once and retries", async () => {
  const dom = installDom();
  const message = pagedMessage();
  const pages: Record<string, unknown> = {
    [LATEST]: view([], 300, "tok-300"),
    [`${LATEST}&before_cursor_token=tok-300`]: view([{
      ...message,
      attachments: [{ ...message.attachments![0]!, signed_url: FRESH }],
    }], 20, "tok-20"),
  };
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    requests.push(path);
    return new Response(JSON.stringify({ data: pages[path] ?? {} }), { status: 200 });
  }) as typeof fetch;
  const root = createRoot(dom.window.document.querySelector("#root")!);

  await act(async () => root.render(
    <MessageContent copied={false} footerMeta={null} message={message} />,
  ));
  const image = () => dom.window.document.querySelector('[data-test-class="markdown-inline-image"]')!;
  expect(image().getAttribute("src")).toBe(STALE);

  await act(async () => { image().dispatchEvent(new dom.window.Event("error")); });
  await settle();
  expect(requests).toEqual(Object.keys(pages));
  expect(image().getAttribute("src")).toBe(FRESH);

  await act(async () => { image().dispatchEvent(new dom.window.Event("error")); });
  await settle();
  expect(requests).toHaveLength(2);
  await act(async () => root.unmount());
});

function pagedMessage(): MessageRecord {
  return {
    id: "message-40",
    chat_id: "session-1",
    role: "assistant",
    status: "delivered",
    text: "![shot](shot.png)",
    cursor: 40,
    attachments: [{
      file_id: "file-11111111-1111-4111-8111-111111111111",
      kind: "image",
      mime_type: "image/png",
      safe_name: "shot.png",
      size_bytes: 10,
      sha256: "a".repeat(64),
      url: PATH,
      signed_url: STALE,
      created_at: "2026-09-28T00:00:00.000Z",
    }],
  };
}

function view(messages: unknown[], previousCursor: number, token: string) {
  return {
    session_id: "session-1",
    messages,
    message_window: {
      next_cursor: 500,
      complete: false,
      previous_cursor: previousCursor,
      previous_cursor_token: token,
    },
  };
}

async function settle() {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
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
