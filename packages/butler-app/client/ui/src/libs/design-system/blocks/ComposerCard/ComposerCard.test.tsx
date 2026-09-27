import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { ComposerCard } from "./ComposerCard";
import { ComposerSendButton } from "./ComposerSendButton";

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

test("send button with a disabledReason stays hoverable but cannot submit", () => {
  const html = renderToStaticMarkup(
    <ComposerSendButton aria-label="Send" disabledReason="Model doesn't accept images" />,
  );
  const button = new JSDOM(html).window.document.querySelector('[data-test-class="composer-send-button"]');
  expect(button?.getAttribute("aria-disabled")).toBe("true");
  expect(button?.getAttribute("type")).toBe("button");
  expect(button?.hasAttribute("disabled")).toBe(false);
  const css = readFileSync(new URL("./ComposerCard.module.css", import.meta.url), "utf8");
  expect(css).toMatch(/\.sendButton:disabled,\s*\.sendButton\[aria-disabled="true"\]\s*\{/u);
});
