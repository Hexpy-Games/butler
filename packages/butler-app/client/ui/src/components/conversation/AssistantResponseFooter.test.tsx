/// <reference types="bun" />

import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantResponseFooter } from "./AssistantResponseFooter";
import { BranchMessageActions } from "./BranchMessageActions";

test("branch icon actions stay between copy and timing in the metadata row", () => {
  const html = renderToStaticMarkup(<AssistantResponseFooter copied={false} onCopy={() => {}}
    meta={{ durationLabel: "12초", timeLabel: "오전 1:23", completedAtIso: null }}
    actions={<BranchMessageActions sessionId="general" messageId="answer" />} />);
  const copy = html.indexOf('aria-label="Copy assistant response"');
  const topic = html.indexOf('aria-label="새 주제대화 시작"');
  const project = html.indexOf('aria-label="새 프로젝트 시작"');
  const duration = html.indexOf("Worked for");
  expect(copy).toBeGreaterThan(-1);
  expect(topic).toBeGreaterThan(copy);
  expect(project).toBeGreaterThan(topic);
  expect(duration).toBeGreaterThan(project);
  expect(html).not.toContain(">새 주제대화 시작</button>");
  expect(html).not.toContain(">새 프로젝트 시작</button>");
});

test("delivered assistant footer keeps completion in a separate bottom row", () => {
  const html = renderFooter();
  const metadataRow = html.match(
    /<div[^>]*data-test-class="assistant-footer"[^>]*>([\s\S]*?)<\/div>/u,
  )?.[1];
  const statusIndex = html.indexOf("assistant-terminal-status-row");

  expect(metadataRow).toContain("Copy");
  expect(metadataRow).not.toContain("<span>Copy</span>");
  expect(metadataRow).toMatch(/<button[^>]*><svg[\s\S]*?<\/svg><\/button>/u);
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
