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
    '[data-turn-id="prior-turn"] [data-test-class~="toggle-turn-activity-history"]',
  );
  const currentToggle = dom.window.document.querySelector(
    '[data-turn-id="current-turn"] [data-test-class~="toggle-turn-activity-history"]',
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

function timelineBlocks(stages: readonly string[], turnId: string): string {
  return `
    <button
      data-test-class="toggle-turn-activity-history"
      aria-expanded="true"
    >
      펼치기
    </button>
    ${stages.map((stage) => `
      <div
        data-test-class="turn-work-block"
        data-work-stage="${stage}"
      >${turnId} ${stage}</div>
    `).join("")}
  `;
}
