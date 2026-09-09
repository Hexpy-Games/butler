import { expect, test } from "bun:test";
import { getAppCopy, getInterfaceProgressLabel } from "./index.ts";

function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, shape(nested)]));
  return typeof value;
}

test("English and Korean catalogs have complete recursive key and formatter parity", () => {
  expect(shape(getAppCopy("en-US"))).toEqual(shape(getAppCopy("ko-KR")));
  expect(getAppCopy("en-US").conversation.work.collapsedSummary("Read file", 2)).toBe("Read file and 1 more activities");
  expect(getAppCopy("ko-KR").space.general).toBe("일반");
  expect(getAppCopy("en-US").briefing.general.suggestions[0].title).toBe("Worth a short look today");
});

test("runtime-owned operation and progress keys localize without interpreting authored text", () => {
  expect(getInterfaceProgressLabel("operation:read_file", "en-US")).toBe("Reading: checking relevant file contents");
  expect(getInterfaceProgressLabel("operation:read_file", "ko-KR")).toBe("조회: 관련 파일 내용을 확인 중");
  expect(getInterfaceProgressLabel("accepted", "en-US")).toBe("Request accepted.");
  expect(getInterfaceProgressLabel("reconnecting", "ko-KR", { attempt: 2, maxAttempts: 4 })).toBe("재연결 중 (2/4)");
  expect(getInterfaceProgressLabel(undefined, "en-US")).toBeUndefined();
  expect(getInterfaceProgressLabel("작업 중", "en-US")).toBeUndefined();
});
