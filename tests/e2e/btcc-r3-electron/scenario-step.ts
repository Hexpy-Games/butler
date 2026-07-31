import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  AppMessageView,
  AppSessionView,
  ElectronScenarioStep,
  PreparedRun,
  StepObservation,
} from "./contracts.ts";
import {
  bridgeCall,
  openSession,
  replaceInterruptedExecutorOnce,
  rendererFinalText,
  type ProductLaunch,
} from "./product-launch.ts";
import {
  hashText,
  materializePrompt,
  safeSegment,
} from "./scenario-preflight.ts";
import { checkScenarioExpectations } from "./scenario-expectations.ts";
import { readGuidedWorkObservation } from "./work-evidence.ts";

const DEFAULT_STEP_TIMEOUT_MS = 10 * 60_000;
const TERMINAL_STATES = new Set(["cancelled", "delivered", "failed"]);

interface TerminalObservation {
  acknowledgedAtMs: number;
  firstRenderedActivityAtMs: number | null;
  progressMessages: string[];
  terminalAtMs: number;
  turnId: string;
  view: AppSessionView;
}

export function isTransientSessionReadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:Request failed|Failed to fetch|fetch failed|ECONNREFUSED)/iu
    .test(message);
}

function progressLabels(view: AppSessionView): string[] {
  const turn = view.active_turn ?? view.latest_turn;
  const labels = (turn?.progress?.safe_progress_rows ?? [])
    .map((row) => row.safe_label?.trim())
    .filter((value): value is string => Boolean(value));
  const summary = turn?.progress?.summary?.trim();
  return [...new Set(summary ? [summary, ...labels] : labels)];
}

function assistantForTurn(
  view: AppSessionView,
  turnId: string,
): AppMessageView | null {
  return [...(view.messages ?? [])]
    .reverse()
    .find((message) =>
      message.role === "assistant" && message.turn_id === turnId,
    ) ?? null;
}

async function waitForTurn(
  run: PreparedRun,
  launch: ProductLaunch,
  previousTurnId: string | null,
  timeoutMs: number,
  submittedAtMs: number,
): Promise<TerminalObservation> {
  const startedAt = Date.now();
  let acknowledgedAtMs: number | null = null;
  let firstRenderedActivityAtMs: number | null = null;
  let turnId: string | null = null;
  const progress = new Set<string>();
  while (Date.now() - startedAt < timeoutMs) {
    await replaceInterruptedExecutorOnce(run, launch);
    let view: AppSessionView;
    try {
      view = await bridgeCall<AppSessionView>(launch.page, "getSessionView", {
        sessionId: run.sessionId,
      });
    } catch (error) {
      if (!isTransientSessionReadError(error)) throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      continue;
    }
    const candidate = view.active_turn ?? view.latest_turn;
    if (candidate?.id && candidate.id !== previousTurnId) {
      turnId ??= candidate.id;
      acknowledgedAtMs ??= Date.now();
      for (const label of progressLabels(view)) progress.add(label);
      if (firstRenderedActivityAtMs === null) {
        const visibleActivity = await launch.page.innerText(
          '[data-test-class="turn-current-status-content"], [data-test-class="turn-result-section"]',
          { last: true },
        ).catch(() => "");
        if (visibleActivity.trim()) firstRenderedActivityAtMs = Date.now();
      }
      if (
        view.status && TERMINAL_STATES.has(view.status) &&
        view.latest_turn?.id === turnId
      ) {
        return {
          acknowledgedAtMs,
          firstRenderedActivityAtMs,
          progressMessages: [...progress],
          terminalAtMs: Date.now(),
          turnId,
          view,
        };
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(
    `Timed out waiting for Electron Turn after ${Date.now() - submittedAtMs} ms.`,
  );
}

export async function verifyDurableFinal(
  run: PreparedRun,
  launch: ProductLaunch,
  turnId: string,
  expectedFinal: string,
): Promise<boolean> {
  await openSession(run, launch.page);
  const view = await bridgeCall<AppSessionView>(launch.page, "getSessionView", {
    sessionId: run.sessionId,
  });
  const assistant = assistantForTurn(view, turnId);
  if (!assistant || !expectedFinal.trim() || assistant.text !== expectedFinal) {
    return false;
  }
  const rendered = await rendererFinalText(launch.page);
  return rendered.trim().length > 0;
}

export async function runScenarioStep(
  run: PreparedRun,
  launch: ProductLaunch,
  step: ElectronScenarioStep,
  prior: ReadonlyMap<string, StepObservation>,
): Promise<StepObservation> {
  const before = await bridgeCall<AppSessionView>(launch.page, "getSessionView", {
    sessionId: run.sessionId,
  });
  const previousTurnId = before.latest_turn?.id ?? null;
  const prompt = materializePrompt(step.prompt, run);
  await launch.page.fill('[data-test-class="composer-card"] textarea', prompt);
  const submittedAtMs = Date.now();
  await launch.page.clickSelector('[data-test-class="composer-send-button"]');
  const terminal = await waitForTurn(
    run,
    launch,
    previousTurnId,
    step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
    submittedAtMs,
  );
  const assistant = assistantForTurn(terminal.view, terminal.turnId);
  const finalText = assistant?.text ?? "";
  const renderedFinal = assistant
    ? await rendererFinalText(launch.page)
    : "";
  const work = readGuidedWorkObservation(run, terminal.turnId);
  const screenshotDir = join(run.runRoot, "screenshots");
  mkdirSync(screenshotDir, { recursive: true });
  const finalScreenshot = join(
    screenshotDir,
    `${safeSegment(step.id, "step")}-final.png`,
  );
  await launch.page.screenshot(finalScreenshot);
  const terminalState = terminal.view.status ?? "unknown";
  const observation: StepObservation = {
    stepId: step.id,
    promptSha256: hashText(prompt),
    turnId: terminal.turnId,
    terminalState,
    finalText,
    rendererFinalText: renderedFinal,
    providerReportedModel:
      terminal.view.latest_turn?.execution_model?.model_ref ??
      terminal.view.latest_turn?.execution_controls?.model_ref ??
      null,
    progressMessages: terminal.progressMessages,
    work,
    timing: {
      submittedAtMs,
      acknowledgedAtMs: terminal.acknowledgedAtMs,
      firstRenderedActivityAtMs: terminal.firstRenderedActivityAtMs,
      terminalAtMs: terminal.terminalAtMs,
      elapsedMs: terminal.terminalAtMs - submittedAtMs,
    },
    expectations: checkScenarioExpectations(
      run,
      step,
      terminalState,
      finalText,
      work,
      prior,
    ),
    reload: { tested: false, finalMatched: null },
    restart: { tested: false, finalMatched: null },
    screenshots: [finalScreenshot],
  };
  if (step.reloadAfter !== false) {
    await launch.page.reload();
    observation.reload = {
      tested: true,
      finalMatched: await verifyDurableFinal(
        run,
        launch,
        terminal.turnId,
        finalText,
      ),
    };
    const screenshot = join(
      screenshotDir,
      `${safeSegment(step.id, "step")}-reload.png`,
    );
    await launch.page.screenshot(screenshot);
    observation.screenshots.push(screenshot);
  }
  return observation;
}
