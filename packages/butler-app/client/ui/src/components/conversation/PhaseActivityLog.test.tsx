/// <reference types="bun" />

import { expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TurnActivityTimeline } from "./TurnActivityTimeline";

test("current phase activity keeps the latest model-authored intent visible", () => {
  const html = renderToStaticMarkup(
    <TurnActivityTimeline
      currentState="planning_review"
      live
      activities={[
        {
          id: "conception-1",
          phase: "conception_deliberation",
          title: "스펙과 구현 확인",
          summary: "관련 스펙과 현재 구현을 함께 확인하고 있습니다.",
          rationale: "사용자 의도와 기존 설계가 어긋나지 않게 범위를 정합니다.",
          nextStep: "확인한 내용을 목표 계약으로 정리합니다.",
          operations: [],
        },
        {
          id: "planning-1",
          phase: "planning",
          title: "수정 계획 구체화",
          summary: "수정할 모듈과 검증 경로를 구체화하고 있습니다.",
          rationale: "불필요한 변경 없이 완료 가능한 작업 단위로 나누기 위해 필요합니다.",
          nextStep: "계획 후보를 독립적으로 검토합니다.",
          operations: [],
        },
      ]}
    />,
  );

  expect(html).toContain("현재 · 계획 검토 · 2개 기록");
  expect(html).not.toContain("관련 스펙과 현재 구현을 함께 확인하고 있습니다.");
  expect(html).not.toContain("사용자 의도와 기존 설계가 어긋나지 않게 범위를 정합니다.");
  expect(html).toContain("수정할 모듈과 검증 경로를 구체화하고 있습니다.");
  expect(html).toContain("다음: 계획 후보를 독립적으로 검토합니다.");
  expect(html).not.toContain("전체 보기");
  expect(html).toContain('data-test-class="toggle-turn-activity-disclosure"');
});

test("ordinary activity defaults to 작업 중 without inventing a phase or plan step", () => {
  const html = renderToStaticMarkup(
    <TurnActivityTimeline
      live
      activities={[{
        id: "ordinary-1",
        title: "파일 읽기",
        summary: "작업공간 파일을 확인하고 있습니다.",
        operations: [],
      }]}
    />,
  );

  expect(html).toContain("현재 · 작업 중 · 1개 기록");
  expect(html).toContain("작업공간 파일을 확인하고 있습니다.");
  expect(html).not.toContain("실행");
  expect(html).not.toContain("다음:");
  expect(html).not.toContain("data-work-stage");
});

test("plan-backed activity keeps its authored next step", () => {
  const html = renderToStaticMarkup(
    <TurnActivityTimeline
      live
      activities={[{
        id: "plan-1",
        phase: "planning",
        title: "실행 계획 수립",
        summary: "수정할 경로를 계획했습니다.",
        nextStep: "구현 경로를 수정합니다.",
        operations: [],
      }]}
    />,
  );

  expect(html).toContain("현재 · 계획 · 1개 기록");
  expect(html).toContain("다음: 구현 경로를 수정합니다.");
});
