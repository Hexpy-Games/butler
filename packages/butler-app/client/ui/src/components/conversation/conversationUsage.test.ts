// test-category: race
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
    expect(conversationUsageSummary({ mode: "subscription", context, view: null, status: "loading" })?.state).toBe("loading");
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

  test("a ChatGPT plan without headers retains the plan and Butler usage", () => {
    expect(conversationUsageSummary({ mode: "subscription", context, view: usageView(), status: "ready" })?.planUsage?.state).toBe("in_use");
    const noWindows = usageView({ quota: quota({ windows: [] }) });
    expect(conversationUsageSummary({ mode: "subscription", context, view: noWindows, status: "ready" })?.butlerUsage?.windows.length).toBe(3);
    const otherProvider = { ...context, provider_id: "anthropic" };
    expect(conversationUsageSummary({ mode: "subscription", context: otherProvider, view: usageView({ quota: quota() }), status: "ready" })?.state)
      .toBe("unavailable");
  });

  test("a stale quota keeps its windows and adds the updated time", () => {
    const summary = conversationUsageSummary({ mode: "subscription", context, view: usageView({ quota: quota({ stale: true, sourceKind: "provider_quota", planUsage: null }) }), status: "ready" })!;
    expect(summary.quotaWindows!.length).toBe(2);
    expect(String(summary.updatedLabel)).toBe(`Updated ${usageTime("2026-09-28T05:05:00.000Z")}`);
  });

});
