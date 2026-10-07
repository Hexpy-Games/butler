// test-category: security
/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { appCopy } from "@/app/copy.ts";
import type { SessionArtifactSummary } from "@/app/types.ts";
import {
  rememberSignedFileUrls,
  resetMessageFileUrlsForTest,
} from "@/app/messageFileUrls.ts";
import { ArtifactViewer } from "./ArtifactViewer";

const PATH = "/message-files/file-11111111-1111-4111-8111-111111111111";
const SERVER = "http://127.0.0.1:18765";
const STALE = `${PATH}?expires=1900000000&signature=${"s".repeat(43)}`;
const FRESH = `${PATH}?expires=1900000600&signature=${"f".repeat(43)}`;
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetMessageFileUrlsForTest();
  for (const name of ["window", "document", "navigator", "HTMLElement", "Node", "IS_REACT_ACT_ENVIRONMENT"]) {
    delete (globalThis as Record<string, unknown>)[name];
  }
});

test("text artifacts fetch the signed URL and refetch once after a refused load", async () => {
  const dom = installDom();
  const requests = stubFetch((url) => url.endsWith(FRESH)
    ? new Response("fresh body", { status: 200 })
    : new Response("", { status: 401 }));
  let refreshes = 0;
  const root = createRoot(dom.window.document.querySelector("#root")!);

  await act(async () => root.render(
    <ArtifactViewer
      artifact={textArtifact()}
      onBack={() => {}}
      refreshFileUrls={async () => {
        refreshes += 1;
        rememberSignedFileUrls([{ url: PATH, signed_url: FRESH }]);
      }}
    />,
  ));
  await settle();

  expect(requests).toEqual([`${SERVER}${STALE}`, `${SERVER}${FRESH}`]);
  expect(refreshes).toBe(1);
  expect(dom.window.document.body.textContent).toContain("fresh body");
  await act(async () => root.unmount());
});

test("a refresh that brings no new URL ends in the failed state without looping", async () => {
  const dom = installDom();
  const requests = stubFetch(() => new Response("", { status: 401 }));
  let refreshes = 0;
  const root = createRoot(dom.window.document.querySelector("#root")!);

  await act(async () => root.render(
    <ArtifactViewer
      artifact={textArtifact()}
      onBack={() => {}}
      refreshFileUrls={async () => { refreshes += 1; }}
    />,
  ));
  await settle();

  expect(requests).toEqual([`${SERVER}${STALE}`]);
  expect(refreshes).toBe(1);
  expect(dom.window.document.body.textContent).toContain(appCopy.artifacts.loadFailed);
  await act(async () => root.unmount());
});

test("image artifacts swap to a refreshed signed URL after an error", async () => {
  const dom = installDom();
  let refreshes = 0;
  const root = createRoot(dom.window.document.querySelector("#root")!);

  await act(async () => root.render(
    <ArtifactViewer
      artifact={{ ...textArtifact(), title: "chart.png", kind: "image" }}
      onBack={() => {}}
      refreshFileUrls={async () => {
        refreshes += 1;
        rememberSignedFileUrls([{ url: PATH, signed_url: FRESH }]);
      }}
    />,
  ));
  const image = () => dom.window.document.querySelector("img")!;
  expect(image().getAttribute("src")).toBe(`${SERVER}${STALE}`);

  await act(async () => { image().dispatchEvent(new dom.window.Event("error")); });
  expect(image().getAttribute("src")).toBe(`${SERVER}${FRESH}`);
  await act(async () => { image().dispatchEvent(new dom.window.Event("error")); });
  expect(refreshes).toBe(1);
  await act(async () => root.unmount());
});

test("a PDF frame refreshes an expired signed URL once before loading", async () => {
  const dom = installDom();
  const expired = `${PATH}?expires=1000&signature=${"e".repeat(43)}`;
  let refreshes = 0;
  const root = createRoot(dom.window.document.querySelector("#root")!);
  const render = () => root.render(
    <ArtifactViewer
      artifact={{ ...textArtifact(), title: "report.pdf", kind: "report", signed_url: expired }}
      onBack={() => {}}
      refreshFileUrls={async () => {
        refreshes += 1;
        rememberSignedFileUrls([{ url: PATH, signed_url: FRESH }]);
      }}
    />,
  );

  await act(async () => render());
  await settle();
  expect(dom.window.document.querySelector("iframe")?.getAttribute("src")).toBe(`${SERVER}${FRESH}`);
  await act(async () => render());
  expect(refreshes).toBe(1);
  await act(async () => root.unmount());
});

function textArtifact(): SessionArtifactSummary {
  return {
    id: "artifact-1",
    title: "notes.md",
    kind: "document",
    url: PATH,
    signed_url: STALE,
    created_at: "2026-09-28T00:00:00.000Z",
  };
}

function stubFetch(respond: (url: string) => Response): string[] {
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    return respond(url);
  }) as typeof fetch;
  return requests;
}

async function settle() {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
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
