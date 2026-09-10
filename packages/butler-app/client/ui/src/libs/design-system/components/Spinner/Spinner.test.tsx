import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposerSendButton } from "../../blocks/ComposerCard";
import { Spinner } from "./Spinner";

test("spinner is decorative beside text and exposes a caller-supplied standalone status", () => {
  const dom = new JSDOM(renderToStaticMarkup(
    <div><Spinner size={14} /><Spinner size={24} label="기록 불러오는 중" /></div>,
  ));
  const [decorative, named] = dom.window.document.querySelectorAll("svg");
  expect(decorative?.getAttribute("aria-hidden")).toBe("true");
  expect(decorative?.hasAttribute("role")).toBe(false);
  expect(named?.getAttribute("role")).toBe("status");
  expect(named?.getAttribute("aria-label")).toBe("기록 불러오는 중");
  expect(named?.hasAttribute("aria-hidden")).toBe(false);
  dom.window.close();
});

test("composer busy uses the DS spinner without changing submit, stop, or disabled semantics", () => {
  const dom = new JSDOM(renderToStaticMarkup(
    <div>
      <ComposerSendButton busy aria-label="Connecting" />
      <ComposerSendButton aria-label="Send" />
      <ComposerSendButton mode="stop" aria-label="Stop" />
    </div>,
  ));
  const [busy, send, stop] = dom.window.document.querySelectorAll("button");
  expect(busy?.disabled).toBe(true);
  expect(busy?.type).toBe("button");
  expect(busy?.getAttribute("aria-busy")).toBe("true");
  expect(busy?.querySelector('[data-slot="spinner"]')).not.toBeNull();
  expect(send?.disabled).toBe(false);
  expect(send?.type).toBe("submit");
  expect(send?.querySelector('[data-slot="spinner"]')).toBeNull();
  expect(stop?.type).toBe("button");
  expect(stop?.querySelector('[data-slot="spinner"]')).toBeNull();
  dom.window.close();
});
