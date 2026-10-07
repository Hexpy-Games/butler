// test-category: security
/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { refreshSessionFileUrls } from "./messageFileRefresh.ts";
import { messageFileSource, resetMessageFileUrlsForTest } from "./messageFileUrls.ts";

const PATH = "/message-files/file-11111111-1111-4111-8111-111111111111";
const FRESH = `${PATH}?expires=1900000600&signature=${"f".repeat(43)}`;
const LATEST = "/session-view?session_id=session-1";

afterEach(() => resetMessageFileUrlsForTest());

function page(previousCursor: number | undefined, token?: string, messages: unknown[] = []) {
  return {
    messages,
    message_window: {
      next_cursor: 500,
      complete: false,
      ...(previousCursor === undefined ? {} : { previous_cursor: previousCursor }),
      ...(token ? { previous_cursor_token: token } : {}),
    },
  };
}

const signedMessage = { attachments: [{ url: PATH, signed_url: FRESH }] };

test("concurrent failures share one session refresh and remember its signed URLs", async () => {
  const requests: string[] = [];
  let release: (value: unknown) => void = () => {};
  const load = (path: string) => {
    requests.push(path);
    return new Promise((resolve) => { release = resolve; });
  };

  const first = refreshSessionFileUrls("session-1", {}, load);
  const second = refreshSessionFileUrls("session-1", {}, load);
  release({ messages: [signedMessage] });
  await Promise.all([first, second]);

  expect(requests).toEqual([LATEST]);
  expect(messageFileSource({ url: PATH })).toBe(FRESH);

  const later = refreshSessionFileUrls("session-1", {}, load);
  release({});
  await later;
  expect(requests).toHaveLength(2);
});

test("a file in an older page is re-signed by paging back to that page", async () => {
  const requests: string[] = [];
  const pages: Record<string, unknown> = {
    [LATEST]: page(300, "tok-300"),
    [`${LATEST}&before_cursor_token=tok-300`]: page(100, "tok-100"),
    [`${LATEST}&before_cursor_token=tok-100`]: page(20, "tok-20", [signedMessage]),
  };
  await refreshSessionFileUrls("session-1", { cursor: 40 }, async (path) => {
    requests.push(path);
    return pages[path];
  });

  expect(requests).toEqual(Object.keys(pages));
  expect(messageFileSource({ url: PATH })).toBe(FRESH);
});

test("a deeper failure joins the running refresh instead of starting another", async () => {
  const requests: string[] = [];
  let releaseLatest: (value: unknown) => void = () => {};
  const load = (path: string) => {
    requests.push(path);
    if (path === LATEST) return new Promise((resolve) => { releaseLatest = resolve; });
    return Promise.resolve(page(10, "tok-10", [signedMessage]));
  };

  const latestOnly = refreshSessionFileUrls("session-1", {}, load);
  const deeper = refreshSessionFileUrls("session-1", { cursor: 40 }, load);
  releaseLatest(page(300, "tok-300"));
  await Promise.all([latestOnly, deeper]);

  expect(requests).toEqual([LATEST, `${LATEST}&before_cursor_token=tok-300`]);
});

test("paging back is bounded and stops at the first page", async () => {
  const requests: string[] = [];
  let pageIndex = 0;
  await refreshSessionFileUrls("session-1", { cursor: 1 }, async (path) => {
    requests.push(path);
    pageIndex += 1;
    return page(10_000 - pageIndex, `tok-${pageIndex}`);
  });
  expect(requests.length).toBeLessThanOrEqual(5);

  const firstPage: string[] = [];
  await refreshSessionFileUrls("session-2", { cursor: 1 }, async (path) => {
    firstPage.push(path);
    return page(5);
  });
  expect(firstPage).toEqual(["/session-view?session_id=session-2"]);
});

test("local-only sessions and failed loads refresh nothing", async () => {
  const requests: string[] = [];
  const load = async (path: string) => { requests.push(path); return {}; };
  await refreshSessionFileUrls("", {}, load);
  await refreshSessionFileUrls("dashboard:project-1", {}, load);
  expect(requests).toEqual([]);
  await refreshSessionFileUrls("session-2", {}, async () => { throw new Error("offline"); });
  expect(messageFileSource({ url: PATH })).toBe(PATH);
});
