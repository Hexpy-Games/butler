import { expect, test } from "bun:test";
import type { MessageRecord } from "@/app/types.ts";
import { buildAssistantFooterMetaById } from "./messageFooterMeta";

function durationFor(seconds: number): string | null {
  const start = Date.parse("2026-09-25T10:00:00.000Z");
  const messages: MessageRecord[] = [
    { id: "u", role: "user", text: "hi", turn_id: "t", created_at: new Date(start).toISOString() },
    { id: "a", role: "assistant", text: "ok", turn_id: "t", created_at: new Date(start + seconds * 1000).toISOString() },
  ];
  return buildAssistantFooterMetaById(messages).get("a")?.durationLabel ?? null;
}

test("worked duration reads seconds under a minute and m/ss from a minute on", () => {
  expect(durationFor(0)).toBe("0s");
  expect(durationFor(2)).toBe("2s");
  expect(durationFor(59)).toBe("59s");
  expect(durationFor(60)).toBe("1m 00s");
  expect(durationFor(65)).toBe("1m 05s");
  expect(durationFor(754)).toBe("12m 34s");
});
