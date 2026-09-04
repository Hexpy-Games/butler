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

test("composer card exposes token-backed file drop feedback", () => {
  const html = renderToStaticMarkup(
    <ComposerCard dropActive>
      <span>Composer content</span>
    </ComposerCard>,
  );

  expect(html).toContain('data-drop-active="true"');
});

test("composer drawer is an inline sibling after the form", () => {
  const html = renderToStaticMarkup(
    <ComposerCard drawer={<span>Drawer content</span>}>
      <span>Composer content</span>
    </ComposerCard>,
  );

  const formEnd = html.indexOf("</form>");
  const drawer = html.indexOf('data-test-class="composer-drawer-slot"');
  expect(formEnd).toBeGreaterThan(-1);
  expect(drawer).toBeGreaterThan(formEnd);
});
