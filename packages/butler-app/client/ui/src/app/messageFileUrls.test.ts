/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import {
  absoluteGatewayUrl,
  claimMessageFileRetry,
  messageFilePath,
  messageFileSource,
  rememberSignedFileUrls,
  resetMessageFileUrlsForTest,
  settleMessageFileLoad,
  signedFileUrlsVersion,
  signedMessageFileUrl,
  signedUrlExpiry,
  subscribeSignedFileUrls,
} from "./messageFileUrls.ts";

const PATH = "/message-files/file-11111111-1111-4111-8111-111111111111";
const OTHER_PATH = "/message-files/file-22222222-2222-4222-8222-222222222222";
const SIGNATURE = "a".repeat(40) + "_-Z";

function signed(path: string, expires: number, signature = SIGNATURE): string {
  return `${path}?expires=${expires}&signature=${signature}`;
}

afterEach(() => {
  resetMessageFileUrlsForTest();
  delete (globalThis as { window?: unknown }).window;
});

test("message file paths stay strict", () => {
  expect(messageFilePath(PATH)).toBe(PATH);
  expect(messageFilePath(`${PATH}?expires=1`)).toBeUndefined();
  expect(messageFilePath("/message-files/../settings")).toBeUndefined();
  expect(messageFilePath(`http://127.0.0.1:1${PATH}`)).toBeUndefined();
  expect(messageFilePath(undefined)).toBeUndefined();
});

test("signed URLs must name the same file with only expires and signature", () => {
  const valid = signed(PATH, 1_900_000_000);
  expect(signedMessageFileUrl({ url: PATH, signed_url: valid })).toBe(valid);
  expect(signedUrlExpiry(valid)).toBe(1_900_000_000);

  const rejected = [
    signed(OTHER_PATH, 1_900_000_000),
    `${PATH}?signature=${SIGNATURE}&expires=1900000000`,
    `${valid}&extra=1`,
    `${valid}#fragment`,
    `${PATH}?expires=1900000000`,
    signed(PATH, 1_900_000_000, "short"),
    signed(PATH, 1_900_000_000, `${"a".repeat(42)}=`),
    `http://127.0.0.1:1${valid}`,
    `${PATH}/?expires=1900000000&signature=${SIGNATURE}`,
  ];
  for (const signedUrl of rejected) {
    expect(signedMessageFileUrl({ url: PATH, signed_url: signedUrl })).toBeUndefined();
  }
  expect(signedMessageFileUrl({ url: "/elsewhere", signed_url: valid })).toBeUndefined();
});

test("sources prefer a valid signed URL and fall back to the plain path", () => {
  const valid = signed(PATH, 1_900_000_000);
  expect(messageFileSource({ url: PATH, signed_url: valid })).toBe(valid);
  expect(messageFileSource({ url: PATH, signed_url: `${valid}&x=1` })).toBe(PATH);
  expect(messageFileSource({ url: PATH })).toBe(PATH);
  expect(messageFileSource({ url: "/settings", signed_url: valid })).toBeUndefined();
  expect(messageFileSource({})).toBeUndefined();
});

test("a remembered signed URL wins only when it expires later", () => {
  const older = signed(PATH, 1_900_000_000);
  const newer = signed(PATH, 1_900_000_600, "b".repeat(43));
  const versions: number[] = [];
  const unsubscribe = subscribeSignedFileUrls(() => versions.push(signedFileUrlsVersion()));

  rememberSignedFileUrls({
    data: {
      messages: [{ attachments: [{ url: PATH, signed_url: newer }] }],
      artifacts: [{ url: OTHER_PATH, signed_url: `${OTHER_PATH}?bad=1` }],
    },
  });

  expect(versions).toHaveLength(1);
  expect(messageFileSource({ url: PATH, signed_url: older })).toBe(newer);
  expect(messageFileSource({ url: OTHER_PATH })).toBe(OTHER_PATH);

  rememberSignedFileUrls([{ url: PATH, signed_url: older }]);
  expect(versions).toHaveLength(1);
  expect(messageFileSource({ url: PATH })).toBe(newer);

  const newest = signed(PATH, 1_900_001_200, "c".repeat(43));
  expect(messageFileSource({ url: PATH, signed_url: newest })).toBe(newest);
  unsubscribe();
});

test("a file gets one refresh until it loads again", () => {
  expect(claimMessageFileRetry(PATH)).toBe(true);
  expect(claimMessageFileRetry(PATH)).toBe(false);
  expect(claimMessageFileRetry(OTHER_PATH)).toBe(true);
  settleMessageFileLoad(PATH);
  expect(claimMessageFileRetry(PATH)).toBe(true);
});

test("gateway URLs resolve against the desktop server URL", () => {
  expect(absoluteGatewayUrl(PATH)).toBe(PATH);
  (globalThis as { window?: unknown }).window = {
    butlerApp: { serverUrl: "http://127.0.0.1:18765" },
  };
  expect(absoluteGatewayUrl(signed(PATH, 5))).toBe(
    `http://127.0.0.1:18765${signed(PATH, 5)}`,
  );
});
