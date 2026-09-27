/// <reference types="bun" />

import { afterAll, beforeAll, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantResponseFooter } from "./AssistantResponseFooter";
import { BranchMessageActions } from "./BranchMessageActions";
import { getAppLocale, setAppCopyLanguage } from "@/app/copy.ts";

// These expectations are the default (English) copy; pin the locale instead of inheriting it.
const previousLocale = getAppLocale();
beforeAll(() => setAppCopyLanguage("en-US"));
afterAll(() => setAppCopyLanguage(previousLocale));

test("branch icon actions stay between copy and timing in the metadata row", () => {
  const html = renderToStaticMarkup(<AssistantResponseFooter copied={false} onCopy={() => {}}
    meta={{ durationLabel: "12s", timeLabel: "1:23 AM", completedAtIso: null }}
    actions={<BranchMessageActions sessionId="general" messageId="answer" />} />);
  const copy = html.indexOf('aria-label="Copy assistant response"');
  const topic = html.indexOf('aria-label="Start a new conversation"');
  const project = html.indexOf('aria-label="Start a new project"');
  const duration = html.indexOf("Worked for");
  expect(copy).toBeGreaterThan(-1);
  expect(topic).toBeGreaterThan(copy);
  expect(project).toBeGreaterThan(topic);
  expect(duration).toBeGreaterThan(project);
  expect(html).not.toContain(">Start a new conversation</button>");
  expect(html).not.toContain(">Start a new project</button>");
});

test("delivered assistant footer keeps completion in a separate bottom row", () => {
  const html = renderFooter();
  const metadataRow = html.match(
    /<div[^>]*data-test-class="assistant-footer"[^>]*>([\s\S]*?)<\/div>/u,
  )?.[1];
  const statusIndex = html.indexOf("assistant-terminal-status-row");

  expect(metadataRow).toContain("Copy");
  expect(metadataRow).not.toContain("<span>Copy</span>");
  // Icon-only copy button: the copy and check glyphs share one hidden wrapper
  // (the check glyph sits in its own animated span since f50145530).
  expect(metadataRow).toMatch(/<button[^>]*><span[^>]*aria-hidden="true"[^>]*><svg[\s\S]*?<\/svg>(?:<\/span>)+<\/button>/u);
  expect(metadataRow).toContain("Worked for 12s");
  expect(metadataRow).toContain("1:23 AM");
  expect(metadataRow).not.toContain("assistant-status-label");
  expect(statusIndex).toBeGreaterThan(html.indexOf("1:23 AM"));
  expect(html).toContain('data-test-class="assistant-terminal-status-row"');
  expect(html).toContain('data-test-class="assistant-status-label"');
  expect(html).toContain('data-test-class="assistant-status-mark-complete"');
  expect(html).toContain("Response completed");
});

test("assistant footer reports failed and cancelled terminal states truthfully", () => {
  expect(renderFooter("failed")).toContain("Response failed");
  expect(renderFooter("failed")).not.toContain("Response completed");
  expect(renderFooter("cancelled")).toContain("Response stopped");
  expect(renderFooter("cancelled")).not.toContain("Response completed");
});

test("pending assistant footer does not duplicate the active status row", () => {
  const html = renderFooter("pending");

  expect(html).not.toContain("assistant-status-label");
  expect(html).not.toContain("Response completed");
  expect(html).toContain("Copy");
});

function renderFooter(status?: string): string {
  return renderToStaticMarkup(
    <AssistantResponseFooter
      copied={false}
      meta={{
        durationLabel: "12s",
        timeLabel: "1:23 AM",
        completedAtIso: "2026-08-04T01:23:00+09:00",
      }}
      status={status}
      onCopy={() => undefined}
    />,
  );
}
