import {
  afterAll,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultSchedulerJobs,
  runSchedulerTick,
} from "../../../packages/butler-agent/src/operations/scheduler/native-scheduler.ts";

const firstLaunchAt = new Date(2026, 7, 14, 12, 0, 0);
const restartLaunchAt = new Date(2026, 7, 15, 12, 0, 0);
const observedSchedulerStates: Array<Record<string, unknown>> = [];
const observedSchedulerSkips: string[][] = [];
const schedulerStatePresentAtLaunch: boolean[] = [];
let stopCount = 0;

mock.module("./product-launch.ts", () => ({
  bridgeCall: async (_page: unknown, method: string, input?: { sessionId?: string }) =>
    method === "getSettings"
      ? { model: "local/test-model" }
      : { session_id: input?.sessionId },
  ensureSession: async () => undefined,
  launchProduct: async (run: { dataRoot: string }) => {
    const statePath = join(
      run.dataRoot,
      "state",
      "scheduler",
      "consolidation-cycle.json",
    );
    schedulerStatePresentAtLaunch.push(existsSync(statePath));
    if (existsSync(statePath)) {
      observedSchedulerStates.push(JSON.parse(
        readFileSync(statePath, "utf8"),
      ) as Record<string, unknown>);
      const consolidationJob = defaultSchedulerJobs().find(
        (job) => job.id === "consolidation-cycle",
      );
      observedSchedulerSkips.push(runSchedulerTick({
        butlerData: run.dataRoot,
        jobs: consolidationJob ? [consolidationJob] : [],
        now: new Date(),
        runCommand: () => {
          throw new Error("isolated launch smoke made consolidation due");
        },
      }).jobsSkipped);
    }
    return {
      child: { pid: 101 },
      executor: null,
      executorPid: 202,
      executorOutput: [],
      interruptedExecutorReplaced: false,
      output: [],
      page: { reload: async () => undefined },
      providerEndpoint: "http://127.0.0.1:1/responses",
      startedAtMs: Date.now(),
    };
  },
  openSession: async () => undefined,
  productLaunchFailureDiagnostics: () => ({ electronOutput: [], executorOutput: [] }),
  rendererFinalText: async () => "",
  rendererVisibleActivities: async () => [],
  replaceInterruptedExecutorOnce: async () => false,
  stopProduct: async () => {
    stopCount += 1;
    if (stopCount === 1) setSystemTime(restartLaunchAt);
  },
}));

mock.module("./provider-observation-proxy.ts", () => ({
  startProviderObservationProxy: async () => ({
    close: async () => [],
    endpoint: "http://127.0.0.1:1/responses",
    observations: () => [],
  }),
}));

mock.module("./scenario-step.ts", () => ({
  runScenarioStep: async (run: { model: string; sessionId: string }) => ({
    expectations: { failures: [], passed: true },
    finalText: "fixture response",
    progressMessages: [],
    providerAgentModels: [run.model],
    providerReportedModel: run.model,
    reload: { finalMatched: null, tested: false },
    rendererActivities: [],
    rendererFinalText: "fixture response",
    restart: { finalMatched: null, tested: false },
    screenshots: [],
    sessionId: run.sessionId,
    stepId: "fixture-step",
    terminalState: "delivered",
    timing: {
      acknowledgedAtMs: Date.now(),
      elapsedMs: 0,
      firstRenderedActivityAtMs: null,
      submittedAtMs: Date.now(),
      terminalAtMs: Date.now(),
    },
    turnId: "fixture-turn",
    work: null,
  }),
  verifyDurableCancelled: async () => true,
  verifyDurableFinal: async () => true,
}));

afterAll(() => {
  setSystemTime();
  mock.restore();
});

test("provider-free launch smoke refreshes consolidation scheduler state before both dated launches", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-launch-smoke-scheduler-"));
  const sourceData = join(root, "source-data");
  mkdirSync(sourceData, { recursive: true });
  writeFileSync(join(sourceData, "butler.config.json"), JSON.stringify({
    models: { registered: [] },
    system: { butlerModel: "local/test-model", defaultModel: "local/test-model" },
  }), "utf8");
  setSystemTime(firstLaunchAt);
  observedSchedulerStates.length = 0;
  observedSchedulerSkips.length = 0;
  schedulerStatePresentAtLaunch.length = 0;
  stopCount = 0;

  try {
    const { runBtccR3ElectronHarness } = await import("./scenario-runner.ts");
    const evidence = await runBtccR3ElectronHarness({
      schema: "butler.btcc-r3-electron-scenario.v1",
      id: "provider-free-launch-smoke",
      providerFixture: { responses: [] },
      steps: [],
    }, {
      model: "local/test-model",
      repoRoot: root,
      runRoot: join(root, "run"),
      smoke: true,
      sourceData,
    });

    expect(evidence.kind).toBe("launch_smoke");
    expect(schedulerStatePresentAtLaunch).toEqual([true, true]);
    expect(observedSchedulerSkips).toEqual([
      ["consolidation-cycle"],
      ["consolidation-cycle"],
    ]);
    expect(observedSchedulerStates).toEqual([
      {
        lastRunDate: "2026-08-14",
      },
      {
        lastRunDate: "2026-08-15",
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider-fixture scenario runs do not write launch-smoke scheduler state", async () => {
  const root = mkdtempSync(join(tmpdir(), "btcc-scenario-scheduler-"));
  const sourceData = join(root, "source-data");
  mkdirSync(sourceData, { recursive: true });
  writeFileSync(join(sourceData, "butler.config.json"), JSON.stringify({
    models: { registered: [] },
    system: { butlerModel: "local/test-model", defaultModel: "local/test-model" },
  }), "utf8");
  setSystemTime(firstLaunchAt);
  observedSchedulerStates.length = 0;
  observedSchedulerSkips.length = 0;
  schedulerStatePresentAtLaunch.length = 0;
  stopCount = 0;

  try {
    const { runBtccR3ElectronHarness } = await import("./scenario-runner.ts");
    const evidence = await runBtccR3ElectronHarness({
      schema: "butler.btcc-r3-electron-scenario.v1",
      id: "provider-fixture-scenario",
      providerFixture: { responses: [] },
      steps: [{ id: "fixture-step", prompt: "fixture prompt" }],
    }, {
      model: "local/test-model",
      repoRoot: root,
      runRoot: join(root, "run"),
      sourceData,
    });

    expect(evidence.kind).toBe("scenario_run");
    expect(schedulerStatePresentAtLaunch).toEqual([false]);
    expect(observedSchedulerStates).toEqual([]);
    expect(observedSchedulerSkips).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
