import { afterEach, describe, expect, test } from "bun:test";
import { setAppCopyLanguage } from "@/app/copy.ts";
import { conversationUsageSummary, usageTime } from "./conversationUsage";
import { quota, usageContext, usageView } from "./contextUsage.fixtures";

afterEach(() => setAppCopyLanguage("en-US"));

const context = usageContext;

describe("conversationUsageSummary", () => {
  test("local and unknown models show no usage section", () => {
    expect(conversationUsageSummary({ mode: "local", context, view: usageView(), status: "ready" })).toBeNull();
    expect(conversationUsageSummary({ mode: "unknown", context, view: usageView(), status: "ready" })).toBeNull();
  });

  test("first fetch is loading; a failed first fetch is unavailable", () => {
    expect(conversationUsageSummary({ mode: "api_key", context, view: null, status: "loading" })?.state).toBe("loading");
    expect(conversationUsageSummary({ mode: "subscription", context, view: null, status: "failed" })?.state).toBe("unavailable");
  });

  test("subscription maps quota windows with left percent and reset caption", () => {
    const summary = conversationUsageSummary({ mode: "subscription", context, view: usageView({ quota: quota() }), status: "ready" })!;
    expect(summary.state).toBe("ready");
    expect(summary.quotaWindows!.map((window) => [window.label, window.remainingPercent])).toEqual([["5-hour limit", 82], ["Weekly limit", 64]]);
    expect(String(summary.quotaWindows![0]!.caption)).toStartWith("Resets ");
    expect(summary.quotaWindows![1]!.caption).toBeUndefined();
    expect(summary.remainingLabel!("82%")).toBe("82% left");
    expect(summary.tokens).toBeUndefined();
    expect(summary.updatedLabel).toBeUndefined();
  });

  test("a subscription without a reported quota is unavailable", () => {
    expect(conversationUsageSummary({ mode: "subscription", context, view: usageView(), status: "ready" })?.state).toBe("unavailable");
    const noWindows = usageView({ quota: quota({ windows: [] }) });
    expect(conversationUsageSummary({ mode: "subscription", context, view: noWindows, status: "ready" })?.state).toBe("unavailable");
    const otherProvider = { ...context, provider_id: "anthropic" };
    expect(conversationUsageSummary({ mode: "subscription", context: otherProvider, view: usageView({ quota: quota() }), status: "ready" })?.state)
      .toBe("unavailable");
  });

  test("a stale quota keeps its windows and adds the updated time", () => {
    const summary = conversationUsageSummary({ mode: "subscription", context, view: usageView({ quota: quota({ stale: true }) }), status: "ready" })!;
    expect(summary.quotaWindows!.length).toBe(2);
    expect(String(summary.updatedLabel)).toBe(`Updated ${usageTime("2026-09-28T05:05:00.000Z")}`);
  });

  test("API keys show conversation tokens; reasoning only when provided", () => {
    const without = conversationUsageSummary({ mode: "api_key", context, view: usageView(), status: "ready" })!;
    expect(without.tokens!.map((row) => [row.id, row.value])).toEqual([["input", 48_200], ["cached", 31_900], ["output", 3_420]]);
    const withReasoning = conversationUsageSummary({ mode: "api_key", context, view: usageView({ reasoning: 1_280 }), status: "ready" })!;
    expect(withReasoning.tokens!.map((row) => row.id)).toEqual(["input", "cached", "output", "reasoning"]);
    expect(withReasoning.quotaWindows).toBeUndefined();
  });

  test("cost is a dash until priced, then an estimate when the rate table has a date", () => {
    expect(conversationUsageSummary({ mode: "api_key", context, view: usageView(), status: "ready" })!.cost).toEqual({ label: "Cost", usd: null, estimated: false });
    expect(conversationUsageSummary({ mode: "api_key", context, view: usageView({ usd: 0.0842, asOf: "2026-09-01" }), status: "ready" })!.cost)
      .toEqual({ label: "Cost", usd: 0.0842, estimated: true });
  });

  test("a failed refetch keeps the last data and marks it stale", () => {
    const summary = conversationUsageSummary({ mode: "api_key", context, view: usageView(), status: "failed" })!;
    expect(summary.state).toBe("ready");
    expect(String(summary.updatedLabel)).toBe(`Updated ${usageTime("2026-09-28T05:10:00.000Z")}`);
  });

  test("Korean copy", () => {
    setAppCopyLanguage("ko-KR");
    const summary = conversationUsageSummary({ mode: "api_key", context, view: usageView(), status: "failed" })!;
    expect(summary.tokens!.map((row) => row.label)).toEqual(["입력", "캐시", "출력"]);
    expect(summary.unavailableLabel).toBe("사용량 확인 불가");
    expect(String(summary.updatedLabel)).toEndWith(" 기준");
    expect(summary.locale).toBe("ko-KR");
  });
});
