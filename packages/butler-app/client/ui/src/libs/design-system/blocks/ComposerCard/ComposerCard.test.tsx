import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposerCard } from "./ComposerCard";

test("composer dependency notice stays outside the collapsible form", () => {
  const html = renderToStaticMarkup(
    <ComposerCard
      expanded={false}
      notice={<span data-test-class="dependency-notice">Install Git</span>}
    >
      <span>Composer content</span>
    </ComposerCard>,
  );

  expect(html.indexOf("dependency-notice")).toBeLessThan(html.indexOf("<form"));
  expect(html).toContain('data-test-class="composer-notice-slot"');
});
