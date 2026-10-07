// test-category: pure-logic
/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import { UsageSummaryRows, type UsageSummaryRowsProps } from "./UsageSummaryRows";
import { formatUsageTokens, formatUsageUsd } from "./usageFormat";

function render(props: UsageSummaryRowsProps) {
  const document = new JSDOM(renderToStaticMarkup(<UsageSummaryRows {...props} />)).window.document;
  const text = document.body.textContent ?? "";
  return { document, text };
}

describe("formatUsageUsd", () => {
  test("two decimals from one cent, four below, and thousands separators", () => {
    expect(formatUsageUsd(0)).toBe("$0.00");
    expect(formatUsageUsd(0.42)).toBe("$0.42");
    expect(formatUsageUsd(0.01)).toBe("$0.01");
    expect(formatUsageUsd(0.0042)).toBe("$0.0042");
    expect(formatUsageUsd(0.00004)).toBe("<$0.0001");
    expect(formatUsageUsd(1.234)).toBe("$1.23");
    expect(formatUsageUsd(1234.5)).toBe("$1,234.50");
  });

  test("USD in every locale", () => {
    expect(formatUsageUsd(0.42)).not.toContain("US");
    expect(formatUsageUsd(Number.NaN)).toBe("—");
  });
});

describe("formatUsageTokens", () => {
  test("compact English uses a lowercase k", () => {
    expect(formatUsageTokens(999, "en-US")).toBe("999");
    expect(formatUsageTokens(12_345, "en-US")).toBe("12.3k");
    expect(formatUsageTokens(200_000, "en-US")).toBe("200k");
    expect(formatUsageTokens(1_234_567, "en-US")).toBe("1.2M");
  });

  test("compact Korean uses 천/만 units", () => {
    expect(formatUsageTokens(12_345, "ko-KR")).toBe("1.2만");
    expect(formatUsageTokens(200_000, "ko-KR")).toBe("20만");
    expect(formatUsageTokens(999, "ko-KR")).toBe("999");
  });
});

describe("UsageSummaryRows", () => {
  test("quota windows show a meter, the left label and the reset caption", () => {
    const { document, text } = render({
      unavailableLabel: "Usage unavailable",
      remainingLabel: (percent) => `${percent} left`,
      quotaWindows: [
        { id: "5h", label: "5-hour", remainingPercent: 90.4, caption: "Resets 14:00" },
        { id: "week", label: "Weekly", remainingPercent: 61 },
      ],
    });
    const meters = document.querySelectorAll('[role="progressbar"]');
    expect(meters.length).toBe(2);
    expect(meters[0]!.getAttribute("aria-valuenow")).toBe("90.4");
    expect(meters[0]!.getAttribute("aria-label")).toBe("5-hour: 90% left");
    expect(text).toContain("90% left");
    expect(text).toContain("Resets 14:00");
    expect(text).toContain("61% left");
    expect(document.querySelector('[data-slot="usage-summary-rows"]')!.getAttribute("data-state")).toBe("ready");
  });

  test("a window without a percent shows a dash instead of a meter", () => {
    const { document, text } = render({
      unavailableLabel: "Usage unavailable",
      quotaWindows: [{ id: "x", label: "Monthly", remainingPercent: null }],
    });
    expect(document.querySelectorAll('[role="progressbar"]').length).toBe(0);
    expect(text).toContain("Monthly");
    expect(text).toContain("—");
  });

  test("token rows format compact counts through AnimatedNumber", () => {
    const { document, text } = render({
      unavailableLabel: "Usage unavailable",
      locale: "en-US",
      tokens: [
        { id: "input", label: "Input", value: 12_345 },
        { id: "cached", label: "Cached", value: 8_000 },
        { id: "output", label: "Output", value: 950 },
      ],
    });
    expect(document.querySelectorAll('[data-test-class="key-value-row"]').length).toBe(3);
    expect(document.querySelectorAll('[data-slot="animated-number"]').length).toBe(3);
    expect(text).toContain("12.3k");
    expect(text).toContain("8k");
    expect(text).toContain("950");
  });

  test("cost shows USD with the estimate marker, or a dash when unpriced", () => {
    const priced = render({
      unavailableLabel: "Usage unavailable",
      estimateLabel: "est.",
      cost: { label: "Cost", usd: 0.0042, estimated: true },
    });
    expect(priced.text).toContain("$0.0042");
    expect(priced.document.querySelector('[data-slot="usage-cost-estimate"]')!.textContent).toBe("est.");

    const exact = render({ unavailableLabel: "Usage unavailable", estimateLabel: "est.", cost: { label: "Cost", usd: 1.5 } });
    expect(exact.text).toContain("$1.50");
    expect(exact.document.querySelector('[data-slot="usage-cost-estimate"]')).toBeNull();

    const unpriced = render({ unavailableLabel: "Usage unavailable", estimateLabel: "est.", cost: { label: "Cost", usd: null, estimated: true } });
    expect(unpriced.text).toContain("Cost");
    expect(unpriced.text).toContain("—");
    expect(unpriced.text).not.toContain("est.");
    expect(unpriced.text).not.toContain("$");
  });

  test("loading renders skeleton rows only", () => {
    const { document, text } = render({
      state: "loading",
      loadingLabel: "Loading usage",
      unavailableLabel: "Usage unavailable",
      tokens: [{ id: "input", label: "Input", value: 1 }],
    });
    const skeleton = document.querySelector('[data-slot="skeleton-rows"]')!;
    expect(skeleton.getAttribute("aria-busy")).toBe("true");
    expect(skeleton.getAttribute("aria-label")).toBe("Loading usage");
    expect(text).not.toContain("Input");
  });

  test("unavailable renders one muted line and nothing else", () => {
    const { document, text } = render({
      state: "unavailable",
      unavailableLabel: "Usage unavailable",
      updatedLabel: "Updated 14:05",
      quotaWindows: [{ id: "5h", label: "5-hour", remainingPercent: 10 }],
    });
    expect(text).toBe("Usage unavailable");
    const line = document.querySelector('[data-slot="usage-unavailable"]')!;
    expect(line.getAttribute("data-tone")).toBe("tertiary");
    expect(document.querySelectorAll('[role="progressbar"]').length).toBe(0);
  });

  test("stale data keeps the rows and adds the updated caption", () => {
    const { document, text } = render({
      unavailableLabel: "Usage unavailable",
      updatedLabel: "Updated 14:05",
      quotaWindows: [{ id: "5h", label: "5-hour", remainingPercent: 40 }],
    });
    expect(document.querySelector('[data-slot="usage-summary-rows"]')!.getAttribute("data-stale")).toBe("true");
    expect(text).toContain("Updated 14:05");
    expect(document.querySelectorAll('[role="progressbar"]').length).toBe(1);
  });
});
