import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { appCopy } from "@/app/copy.ts";
import { ContextUsagePopover } from "./ContextUsagePopover";

test("context usage popover names the context window once", () => {
  const markup = renderToStaticMarkup(
    <ContextUsagePopover context={{ ratio: 0.07, used_tokens: 18000, budget_tokens: 258000 } as never} />,
  );
  const title = appCopy.interfacePanels.contextWindow;
  expect(markup.split(title).length - 1).toBe(1);
  expect(markup).toContain(appCopy.interfaceTemplates.contextMetric("full", 7));
  expect(markup).toContain("18k / 258k");
  expect(markup).toContain('data-numeric="tabular"');
});
