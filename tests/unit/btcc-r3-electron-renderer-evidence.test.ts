import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import type {
  CdpPage,
} from "../e2e/btcc-r3-electron/cdp-page.ts";
import {
  rendererVisibleActivities,
} from "../e2e/btcc-r3-electron/product-launch.ts";
import {
  checkScenarioExpectations,
} from "../e2e/btcc-r3-electron/scenario-expectations.ts";
import type {
  ElectronScenarioStep,
  ElectronWorkStage,
} from "../e2e/btcc-r3-electron/contracts.ts";

test("renderer activity evidence cannot use a prior turn to satisfy the current turn", async () => {
  const expectedStages: ElectronWorkStage[] = [
    "conception",
    "planning",
    "review",
    "execution",
    "review",
    "validation",
    "reporting",
  ];
  const currentTurnStages: ElectronWorkStage[] = ["reporting"];
  const dom = new JSDOM(`
    <section
      data-test-class="turn-current-phase-activity"
      data-turn-id="prior-turn"
    >
      ${timelineBlocks(expectedStages, "prior-turn")}
    </section>
    <section
      data-test-class="turn-current-phase-activity"
      data-turn-id="current-turn"
    >
      ${timelineBlocks(currentTurnStages, "current-turn")}
    </section>
  `, { runScripts: "outside-only", pretendToBeVisual: true });
  const priorToggle = dom.window.document.querySelector(
    '[data-turn-id="prior-turn"] [data-test-class~="toggle-turn-activity-disclosure"]',
  );
  const currentToggle = dom.window.document.querySelector(
    '[data-turn-id="current-turn"] [data-test-class~="toggle-turn-activity-disclosure"]',
  );
  if (!(priorToggle instanceof dom.window.HTMLElement) ||
      !(currentToggle instanceof dom.window.HTMLElement)) {
    throw new Error("Missing activity timeline toggle.");
  }
  priorToggle.setAttribute("aria-expanded", "false");
  currentToggle.setAttribute("aria-expanded", "false");
  let priorToggleClicks = 0;
  let currentToggleClicks = 0;
  priorToggle.addEventListener("click", () => priorToggleClicks++);
  currentToggle.addEventListener("click", () => currentToggleClicks++);
  for (const block of dom.window.document.querySelectorAll(
    '[data-test-class~="turn-work-block"]',
  )) {
    Object.defineProperty(block, "innerText", {
      configurable: true,
      value: block.textContent ?? "",
    });
    Object.defineProperty(block, "getClientRects", {
      configurable: true,
      value: () => [{ width: 1, height: 1 }],
    });
  }
  const page = {
    async evaluate<T>(expression: string): Promise<T> {
      return await dom.window.eval(expression) as T;
    },
  } as unknown as CdpPage;

  const activities = await rendererVisibleActivities(page, "current-turn");

  expect(priorToggleClicks).toBe(0);
  expect(currentToggleClicks).toBe(1);
  expect(activities.map(({ stage }) => stage)).toEqual(currentTurnStages);
  expect(activities[0]).toMatchObject({
    content: "current-turn reporting 상세 내용",
    title: "current-turn reporting",
  });
  const step: ElectronScenarioStep = {
    id: "current-turn",
    prompt: "현재 턴",
    expect: { rendererActivityStagesInclude: expectedStages },
  };
  expect(checkScenarioExpectations(
    { workspaceRoot: "/isolated/workspace" } as Parameters<
      typeof checkScenarioExpectations
    >[0],
    step,
    "delivered",
    "완료",
    null,
    new Map(),
    activities,
  ).failures).toContain(
    "renderer_activity_sequence:reporting:expected_subsequence:conception,planning,review,execution,review,validation,reporting",
  );
});

test("renderer activity contract rejects the repeated legacy label and accepts a concise title", () => {
  const step: ElectronScenarioStep = {
    id: "activity-copy-contract",
    prompt: "명령을 실행해 주세요.",
    expect: { rendererActivityStagesInclude: ["execution"] },
  };
  const run = { workspaceRoot: "/isolated/workspace" } as Parameters<
    typeof checkScenarioExpectations
  >[0];
  const legacy = checkScenarioExpectations(
    run,
    step,
    "delivered",
    "완료",
    null,
    new Map(),
    [{
      content: "작업 실행, 작업 실행...",
      stage: "execution",
      text: "작업 실행, 작업 실행... 내용: 작업 실행, 작업 실행...",
      title: "작업 실행, 작업 실행...",
    }],
  );

  expect(legacy.failures).toContain(
    "renderer_activity_title_content_duplicate:0",
  );
  expect(legacy.failures).toContain("renderer_activity_generic_label_repeated:0");
  expect(checkScenarioExpectations(
    run,
    step,
    "delivered",
    "완료",
    null,
    new Map(),
    [{
      content: "command-result.txt에 고유 표식을 기록했습니다.",
      stage: "execution",
      text: "명령 실행 내용: command-result.txt에 고유 표식을 기록했습니다.",
      title: "명령 실행",
    }],
  )).toEqual({ passed: true, failures: [] });
  expect(checkScenarioExpectations(
    run,
    step,
    "delivered",
    "완료",
    null,
    new Map(),
    [{
      content: null,
      stage: "execution",
      text: "가".repeat(33),
      title: "가".repeat(33),
    }],
  ).failures).toContain("renderer_activity_title_too_long:0:33");
});

test("provider model expectation uses the canonical durable provider/model ref", () => {
  const step: ElectronScenarioStep = {
    id: "canonical-provider-model",
    prompt: "backup 모델을 확인해 주세요.",
    expect: { providerReportedModel: "openai/gpt-5.6-luna" },
  };
  const run = { workspaceRoot: "/isolated/workspace" } as Parameters<
    typeof checkScenarioExpectations
  >[0];

  expect(checkScenarioExpectations(
    run,
    step,
    "delivered",
    "완료",
    null,
    new Map(),
    [],
    [],
    "openai/gpt-5.6-luna",
  )).toEqual({ passed: true, failures: [] });
  expect(checkScenarioExpectations(
    run,
    step,
    "delivered",
    "완료",
    null,
    new Map(),
    [],
    [],
    "gpt-5.6-luna",
  ).failures).toContain(
    "provider_reported_model:gpt-5.6-luna:expected:openai/gpt-5.6-luna",
  );
});

function timelineBlocks(stages: readonly string[], turnId: string): string {
  return `
    <button
      data-test-class="toggle-turn-activity-disclosure"
      aria-expanded="true"
    >
      펼치기
    </button>
    ${stages.map((stage) => `
      <div
        data-test-class="turn-work-block"
        data-work-stage="${stage}"
      >
        <span data-test-class="turn-work-block-header">${turnId} ${stage}</span>
        <div data-slot="work-activity-description">
          <span>${stage} · 현재</span>
          <span>내용: ${turnId} ${stage} 상세 내용</span>
        </div>
      </div>
    `).join("")}
  `;
}
