/// <reference types="bun" />

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageRow, MessageStatusLabel } from "./MessageRow";

test("assistant message row uses one full-width content column", () => {
  const html = renderToStaticMarkup(
    <MessageRow role="assistant">Full-width response</MessageRow>,
  );
  const css = readFileSync(
    new URL("./MessageRow.module.css", import.meta.url),
    "utf8",
  );

  expect(html).toContain('data-test-class="message-body"');
  expect(html).not.toContain("data-role=\"assistant\"");
  expect(css).toMatch(
    /\.assistant\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/su,
  );
  expect(css).not.toMatch(
    /\.assistant\s*\{[^}]*grid-template-columns:\s*28px/su,
  );
});

const messageRowCss = readFileSync(new URL("./MessageRow.module.css", import.meta.url), "utf8");

test("a newly inserted row enters with a fade and a small rise on translate", () => {
  const entering = renderToStaticMarkup(<MessageRow role="user" entering>Sent</MessageRow>);
  expect(entering).toContain('data-enter="true"');
  expect(renderToStaticMarkup(<MessageRow role="user">Old</MessageRow>)).not.toContain("data-enter");
  expect(messageRowCss).toMatch(/\.row\[data-enter="true"\] \{\s*animation: message-enter var\(--motion-base\)\s+var\(--motion-ease-decelerate\)/u);
  const keyframes = messageRowCss.slice(messageRowCss.indexOf("@keyframes message-enter"));
  // The virtualizer positions rows with transform, so the rise uses translate.
  expect(keyframes).toMatch(/opacity: 0;\s*translate: 0 var\(--motion-distance-sm\);/u);
});

test("an active status label shimmers its text and stays static under reduced motion", () => {
  const html = renderToStaticMarkup(<MessageStatusLabel mark={null} shimmer>Thinking</MessageStatusLabel>);
  expect(html).toContain('data-shimmer="true"');
  expect(renderToStaticMarkup(<MessageStatusLabel mark={null}>Done</MessageStatusLabel>)).not.toContain("data-shimmer");
  expect(messageRowCss).toMatch(/\.statusContent\[data-shimmer="true"\] > \* \{[^}]*background-clip: text;[^}]*animation: status-shimmer var\(--shimmer-duration\)\s+var\(--motion-ease-linear\)\s+infinite;/u);
  const reduced = messageRowCss.slice(messageRowCss.indexOf("@media (prefers-reduced-motion: reduce)"));
  expect(reduced).toMatch(/\.statusContent\[data-shimmer="true"\] > \* \{[^}]*animation: none;/u);
});

test("offsetY places a virtualized row with translateY; the row offers no UNSAFE_style", () => {
  const html = renderToStaticMarkup(<MessageRow role="user" offsetY={128}>Placed</MessageRow>);
  expect(html).toContain('style="transform:translateY(128px)"');
  expect(renderToStaticMarkup(<MessageRow role="user">Static</MessageRow>)).not.toContain("style=");
  expect(readFileSync(new URL("./MessageRow.tsx", import.meta.url), "utf8")).not.toContain("UNSAFE_style");
});
