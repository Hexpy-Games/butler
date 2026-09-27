/// <reference types="bun" />

import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { appCopy } from "@/app/copy.ts";
import { AutomationsList } from "./AutomationsList";

test("the automations list shows skeleton rows, not the empty line, until the first load settles", () => {
  const loading = renderToStaticMarkup(
    <AutomationsList automations={[]} loaded={false} onSelectAutomation={() => undefined} onNewAutomation={() => undefined} />,
  );
  expect(loading).toContain('data-slot="skeleton-rows"');
  expect(loading).not.toContain(appCopy.automations.empty);
  const empty = renderToStaticMarkup(
    <AutomationsList automations={[]} loaded onSelectAutomation={() => undefined} onNewAutomation={() => undefined} />,
  );
  expect(empty).toContain(appCopy.automations.empty);
  expect(empty).not.toContain('data-slot="skeleton-rows"');
});
