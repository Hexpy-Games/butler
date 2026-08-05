/// <reference types="bun" />

import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ContextDetailsView } from "@/app/types.ts";
import { ContextPanel } from "./ContextPanel.tsx";

test("context legend swatches correspond to chart category colors and omit reserves", () => {
  const html = renderToStaticMarkup(<ContextPanel context={contextView()} />);

  expect(html).toContain("Static Context");
  expect(html).toContain("Working Context");
  expect(html).toContain("Output Reserve");
  expect(html).toContain("--swatch-color:var(--context-chart-1)");
  expect(html).toContain("--swatch-color:var(--context-chart-2)");
  expect(html).not.toContain("--swatch-color:var(--context-chart-3)");
});

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
    ],
  };
}
