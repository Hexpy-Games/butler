/// <reference types="bun" />

import { expect, test } from "bun:test";
import type { ContextDetailsView } from "@/app/types.ts";
import { buildContextChart } from "./contextPanelUtils.ts";

function contextView(): ContextDetailsView {
  return {
    session_id: "general",
    used_tokens: 150,
    budget_tokens: 500,
    ratio: 0.3,
    status: "low",
    categories: [
      {
        id: "static",
        label: "Static Context",
        used_tokens: 100,
        budget_tokens: 500,
        ratio: 0.2,
        safe_description: "Stable runtime contract",
        source_kind: "static_context",
      },
      {
        id: "working",
        label: "Working Context",
        used_tokens: 50,
        budget_tokens: 500,
        ratio: 0.1,
        safe_description: "Current working material",
        source_kind: "working_context",
      },
      {
        id: "output-reserve",
        label: "Output Reserve",
        used_tokens: 80,
        budget_tokens: 500,
        ratio: 0.16,
        safe_description: "Reserved response capacity",
        source_kind: "output_reserve",
      },
      {
        id: "tool-reserve",
        label: "Tool Reserve",
        used_tokens: 20,
        budget_tokens: 500,
        ratio: 0.04,
        safe_description: "Reserved tool capacity",
        source_kind: "tool_reserve",
      },
    ],
  };
}

test("context chart excludes reserve categories and fills free context from used tokens", () => {
  const chart = buildContextChart(contextView());

  expect(chart.segments.map((segment) => segment.label)).toEqual([
    "Static Context",
    "Working Context",
    "Free context",
  ]);
  expect(chart.segments.reduce((sum, segment) => sum + segment.value, 0)).toBe(
    500,
  );
  expect(chart.segments.find((segment) => segment.key === "free")?.value).toBe(
    350,
  );
  expect(chart.data[0]).toMatchObject({
    category_0: 100,
    category_1: 50,
    free: 350,
  });
});

test("context chart clamps over-budget occupied segments to the visible budget", () => {
  const chart = buildContextChart({
    ...contextView(),
    used_tokens: 700,
    budget_tokens: 500,
    ratio: 1.4,
    categories: contextView().categories.map((category) =>
      category.source_kind === "static_context"
        ? { ...category, used_tokens: 400 }
        : category.source_kind === "working_context"
          ? { ...category, used_tokens: 400 }
          : category,
    ),
  });

  expect(chart.segments.reduce((sum, segment) => sum + segment.value, 0)).toBe(
    500,
  );
  expect(
    chart.segments.find((segment) => segment.category_id === "static")?.value,
  ).toBe(400);
  expect(
    chart.segments.find((segment) => segment.category_id === "working")?.value,
  ).toBe(100);
  expect(chart.segments.some((segment) => segment.key === "free")).toBe(false);
});

test("context chart keeps reserve-only and zero-budget arithmetic finite", () => {
  const reserveOnly = buildContextChart({
    ...contextView(),
    used_tokens: 0,
    budget_tokens: 500,
    ratio: 0,
    categories: contextView().categories.filter((category) =>
      category.source_kind?.endsWith("reserve"),
    ),
  });
  expect(reserveOnly.segments).toEqual([
    expect.objectContaining({
      key: "free",
      value: 500,
    }),
  ]);
  expect(reserveOnly.segments.some((segment) => segment.category_id)).toBe(
    false,
  );

  const zeroBudget = buildContextChart({
    ...contextView(),
    used_tokens: 100,
    budget_tokens: 0,
    ratio: 1,
  });
  expect(zeroBudget.segments).toEqual([]);
  expect(zeroBudget.data[0]).toEqual({ name: "Context" });
});
