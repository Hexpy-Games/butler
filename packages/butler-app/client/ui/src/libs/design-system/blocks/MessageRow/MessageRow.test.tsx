/// <reference types="bun" />

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageRow } from "./MessageRow";

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
