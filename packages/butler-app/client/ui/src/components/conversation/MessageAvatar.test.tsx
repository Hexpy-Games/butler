/// <reference types="bun" />

import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageAvatar } from "./MessageAvatar";

test("assistant rows do not reserve a leading Butler avatar", () => {
  const html = renderToStaticMarkup(
    <MessageAvatar role="assistant" isCompactionEvent={false} />,
  );

  expect(html).toBe("");
});

test("system rows retain their explicit system avatar", () => {
  const html = renderToStaticMarkup(
    <MessageAvatar role="system" isCompactionEvent={false} />,
  );

  expect(html).toContain('data-test-class="message-avatar"');
});
