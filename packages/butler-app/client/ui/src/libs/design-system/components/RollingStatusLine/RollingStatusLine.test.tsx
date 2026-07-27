/// <reference types="bun" />

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RollingStatusLine } from "./RollingStatusLine";

test("rolling status reserves one clipped line", () => {
  const html = renderToStaticMarkup(
    <RollingStatusLine title="Full activity">Current activity</RollingStatusLine>,
  );
  expect(html).toContain('title="Full activity"');
  expect(html).toContain("Current activity");

  const css = readFileSync(
    new URL("./RollingStatusLine.module.css", import.meta.url),
    "utf8",
  );
  expect(css).toContain("height: calc(var(--font-size-3) * var(--line-height-body))");
  expect(css).toContain("text-overflow: ellipsis");
  expect(css).toContain("white-space: nowrap");
  expect(css).not.toContain("min-height:");
  expect(css).not.toContain("max-height:");
});
