import { expect, test } from "bun:test";
import { join } from "node:path";
import type {
  AppSessionView,
  PreparedRun,
} from "../e2e/btcc-r3-electron/contracts.ts";
import type { CdpPage } from "../e2e/btcc-r3-electron/cdp-page.ts";
import {
  readElectronScenario,
  validateElectronScenario,
} from "../e2e/btcc-r3-electron/scenario-preflight.ts";
import {
  waitForTurn,
} from "../e2e/btcc-r3-electron/scenario-step.ts";

const STOP_SCENARIO_PATH = join(
  import.meta.dir,
  "..",
  "e2e",
  "btcc-r3-electron-stop-restart-scenario.json",
);

test("checked-in Electron Stop scenario uses Luna Max and durable state assertions", () => {
  const scenario = readElectronScenario(STOP_SCENARIO_PATH);
  const step = scenario.steps[0];

  expect(scenario.model).toBe("openai/gpt-5.6-luna");
  expect(scenario.reasoningEffort).toBe("max");
  expect(step?.stopAfterAcknowledgement).toBe(true);
  expect(step?.reloadAfter).toBe(true);
  expect(step?.restartAfter).toBe(true);
  expect(step?.expect?.terminalState).toBe("cancelled");
  expect(step?.expect?.finalIncludes).toBeUndefined();
});

test("Electron scenario parser rejects a non-boolean acknowledgement Stop request", () => {
  expect(() => validateElectronScenario({
    schema: "butler.btcc-r3-electron-scenario.v1",
    id: "invalid-stop-request",
    steps: [{
      id: "stop",
      prompt: "계속 실행해 주세요.",
      stopAfterAcknowledgement: "yes",
    }],
  } as unknown)).toThrow("stopAfterAcknowledgement");
});

test("runner clicks the visible Stop button before observing cancelled", async () => {
  const views: AppSessionView[] = [
    {
      active_turn: { id: "turn-stop", state: "streaming" },
      latest_turn: { id: "turn-stop", state: "streaming" },
      session_id: "session-stop",
      status: "active",
    },
    {
      active_turn: null,
      latest_turn: { id: "turn-stop", state: "cancelled" },
      session_id: "session-stop",
      status: "cancelled",
    },
  ];
  const evaluated: string[] = [];
  const rendererClicks: string[] = [];
  const page = {
    clickVisibleSelector: async (selector: string) => {
      rendererClicks.push(selector);
    },
    evaluate: async <T>(expression: string): Promise<T> => {
      evaluated.push(expression);
      if (!expression.includes("getSessionView")) {
        throw new Error("Unexpected renderer evaluation.");
      }
      const view = views.shift();
      if (!view) throw new Error("No deterministic session view remains.");
      return view as T;
    },
    innerText: async () => "진행 중",
  } as unknown as CdpPage;
  const run = { agentOwnership: "electron" } as PreparedRun;
  const launch = { page } as Parameters<typeof waitForTurn>[1];

  const observed = await waitForTurn(
    run,
    launch,
    null,
    2_000,
    Date.now(),
    { stopAfterAcknowledgement: true },
  );

  expect(rendererClicks).toEqual([
    '[data-test-class="composer-send-button"][type="button"]',
  ]);
  expect(observed.view.status).toBe("cancelled");
  expect(
    evaluated.every((expression) => !expression.includes("cancelTurn")),
  ).toBe(true);
});
