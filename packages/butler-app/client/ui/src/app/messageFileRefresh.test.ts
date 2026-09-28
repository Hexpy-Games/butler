/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { refreshSessionFileUrls } from "./messageFileRefresh.ts";
import { messageFileSource, resetMessageFileUrlsForTest } from "./messageFileUrls.ts";

const PATH = "/message-files/file-11111111-1111-4111-8111-111111111111";
const FRESH = `${PATH}?expires=1900000600&signature=${"f".repeat(43)}`;

afterEach(() => resetMessageFileUrlsForTest());

test("concurrent failures share one session refresh and remember its signed URLs", async () => {
  const requests: string[] = [];
  let release: (value: unknown) => void = () => {};
  const load = (path: string) => {
    requests.push(path);
    return new Promise((resolve) => { release = resolve; });
  };

  const first = refreshSessionFileUrls("session-1", load);
  const second = refreshSessionFileUrls("session-1", load);
  release({ messages: [{ attachments: [{ url: PATH, signed_url: FRESH }] }] });
  await Promise.all([first, second]);

  expect(requests).toEqual(["/session-view?session_id=session-1"]);
  expect(messageFileSource({ url: PATH })).toBe(FRESH);

  const later = refreshSessionFileUrls("session-1", load);
  release({});
  await later;
  expect(requests).toHaveLength(2);
});

test("local-only sessions and failed loads refresh nothing", async () => {
  const requests: string[] = [];
  const load = async (path: string) => { requests.push(path); return {}; };
  await refreshSessionFileUrls("", load);
  await refreshSessionFileUrls("dashboard:project-1", load);
  expect(requests).toEqual([]);
  await refreshSessionFileUrls("session-2", async () => { throw new Error("offline"); });
  expect(messageFileSource({ url: PATH })).toBe(PATH);
});
