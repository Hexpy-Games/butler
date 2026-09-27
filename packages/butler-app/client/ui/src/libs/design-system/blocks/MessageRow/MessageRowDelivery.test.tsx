/// <reference types="bun" />

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageRow } from "./MessageRow";

const css = readFileSync(new URL("./MessageRow.module.css", import.meta.url), "utf8");

test("a delivered queued message resolves from the dashed queued bubble to the solid user bubble", () => {
  const html = renderToStaticMarkup(<MessageRow role="user" entering="delivered">Sent</MessageRow>);
  expect(html).toContain('data-enter="delivered"');
  expect(css).toMatch(/\.row\[data-enter="delivered"\] \.body \{[^}]*animation: message-delivered var\(--motion-slow\)\s+var\(--motion-ease-decelerate\)/u);
  const keyframes = css.slice(css.indexOf("@keyframes message-delivered"));
  expect(css).toMatch(/\.row\[data-enter="delivered"\] \.body \{\s*outline: var\(--border-hairline\) dashed transparent;/u);
  expect(keyframes).toMatch(/from \{[^}]*outline-color: var\(--line-strong\);/u);
  // Paint-only properties: no size change between the queued and sent bubble.
  expect(keyframes.slice(0, keyframes.indexOf("}\n}"))).not.toMatch(/\b(width|height|padding|margin|border-width)\s*:/u);
});
