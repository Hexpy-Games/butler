/// <reference types="bun" />

import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantResponseFooter } from "./AssistantResponseFooter";

test("delivered assistant footer keeps completion in a separate bottom row", () => {
  const html = renderFooter();
  const metadataRow = html.match(
    /<div[^>]*data-test-class="assistant-footer"[^>]*>([\s\S]*?)<\/div>/u,
  )?.[1];
  const statusIndex = html.indexOf("assistant-terminal-status-row");

  expect(metadataRow).toContain("Copy");
  expect(metadataRow).toContain("Worked for 12초");
  expect(metadataRow).toContain("오전 1:23");
  expect(metadataRow).not.toContain("assistant-status-label");
  expect(statusIndex).toBeGreaterThan(html.indexOf("오전 1:23"));
  expect(html).toContain('data-test-class="assistant-terminal-status-row"');
  expect(html).toContain('data-test-class="assistant-status-label"');
  expect(html).toContain('data-test-class="assistant-status-mark-complete"');
  expect(html).toContain("답변 완료");
});

test("assistant footer reports failed and cancelled terminal states truthfully", () => {
  expect(renderFooter("failed")).toContain("답변 실패");
  expect(renderFooter("failed")).not.toContain("답변 완료");
  expect(renderFooter("cancelled")).toContain("답변 중지");
  expect(renderFooter("cancelled")).not.toContain("답변 완료");
});

test("pending assistant footer does not duplicate the active status row", () => {
  const html = renderFooter("pending");

  expect(html).not.toContain("assistant-status-label");
  expect(html).not.toContain("답변 완료");
  expect(html).toContain("Copy");
});

function renderFooter(status?: string): string {
  return renderToStaticMarkup(
    <AssistantResponseFooter
      copied={false}
      meta={{
        durationLabel: "12초",
        timeLabel: "오전 1:23",
        completedAtIso: "2026-08-04T01:23:00+09:00",
      }}
      status={status}
      onCopy={() => undefined}
    />,
  );
}
