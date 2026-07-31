import { join } from "node:path";
import type {
  AppSessionView,
  AppSettingsView,
  ElectronHarnessOptions,
  ElectronScenario,
  StepObservation,
} from "./contracts.ts";
import {
  failureEvidence,
  type LaunchObservation,
  successEvidence,
  writeEvidence,
} from "./evidence.ts";
import {
  bindingWorkspace,
  prepareElectronRun,
} from "./isolation-config.ts";
import {
  bridgeCall,
  ensureSession,
  launchProduct,
  openSession,
  stopProduct,
  type ProductLaunch,
} from "./product-launch.ts";
import {
  startProviderObservationProxy,
  type ProviderObservationProxy,
} from "./provider-observation-proxy.ts";
import {
  assert,
  safeSegment,
  validateElectronScenario,
} from "./scenario-preflight.ts";
import {
  runScenarioStep,
  verifyDurableFinal,
} from "./scenario-step.ts";

export async function runBtccR3ElectronHarness(
  scenarioInput: ElectronScenario,
  options: ElectronHarnessOptions = {},
): Promise<Record<string, unknown>> {
  const scenario = validateElectronScenario(scenarioInput);
  assert(
    options.smoke === true || scenario.steps.length > 0,
    "A product scenario needs at least one prompt step.",
  );
  const run = await prepareElectronRun(scenario, options);
  const preflight = {
    ok: true,
    actualProductPath: true,
    credentialsCopiedToIsolatedData: !options.dryRun,
    dataRoot: run.dataRoot,
    electronProfile: run.electronProfile,
    model: run.model,
    reasoningEffort: run.reasoningEffort,
    repoRoot: run.repoRoot,
    runId: run.runId,
    runRoot: run.runRoot,
    sessionKind: run.sessionKind,
    sessionId: run.sessionId,
    sourceDataReadOnly: run.sourceData,
    projectWorkspaceRoot: run.projectWorkspaceRoot,
    workspaceRoot: run.workspaceRoot,
  };
  if (options.dryRun) return preflight;

  let launch: ProductLaunch | null = null;
  let providerProxy: ProviderObservationProxy | null = null;
  const launches: LaunchObservation[] = [];
  const observations: StepObservation[] = [];
  const prior = new Map<string, StepObservation>();
  const stopCurrent = async (): Promise<void> => {
    if (!launch) return;
    const current = launch;
    await stopProduct(run, current);
    launches[launches.length - 1]!.interruptedExecutorReplaced =
      current.interruptedExecutorReplaced;
    launches[launches.length - 1]!.stoppedAtMs = Date.now();
    launch = null;
  };
  try {
    providerProxy = await startProviderObservationProxy({
      upstreamBaseUrl: process.env.BUTLER_CODEX_BASE_URL,
    });
    launch = await launchProduct(run, providerProxy.endpoint);
    launches.push({
      electronPid: launch.child.pid ?? null,
      executorPid: launch.executor.pid ?? null,
      interruptedExecutorReplaced: false,
      startedAtMs: launch.startedAtMs,
      stoppedAtMs: null,
    });
    await ensureSession(run, launch, scenario.fixtures ?? []);
    const settings = await bridgeCall<AppSettingsView>(launch.page, "getSettings");
    assert(
      settings.model === run.model,
      `Electron settings selected ${settings.model}, expected ${run.model}.`,
    );
    assert(
      bindingWorkspace(run) === run.workspaceRoot,
      "Electron session binding escaped the fixture workspace.",
    );

    if (options.smoke) {
      await launch.page.reload();
      await openSession(run, launch.page);
      await stopCurrent();
      launch = await launchProduct(run, providerProxy.endpoint);
      launches.push({
        electronPid: launch.child.pid ?? null,
        executorPid: launch.executor.pid ?? null,
        interruptedExecutorReplaced: false,
        startedAtMs: launch.startedAtMs,
        stoppedAtMs: null,
      });
      await openSession(run, launch.page);
      const restartedView = await bridgeCall<AppSessionView>(
        launch.page,
        "getSessionView",
        { sessionId: run.sessionId },
      );
      assert(
        restartedView.session_id === run.sessionId,
        "Session did not survive Electron restart.",
      );
    } else {
      for (const step of scenario.steps) {
        const observation = await runScenarioStep(run, launch, step, prior);
        observations.push(observation);
        prior.set(step.id, observation);
        if (step.restartAfter === true) {
          await stopCurrent();
          launch = await launchProduct(run, providerProxy.endpoint);
          launches.push({
            electronPid: launch.child.pid ?? null,
            executorPid: launch.executor.pid ?? null,
            interruptedExecutorReplaced: false,
            startedAtMs: launch.startedAtMs,
            stoppedAtMs: null,
          });
          observation.restart = {
            tested: true,
            finalMatched: await verifyDurableFinal(
              run,
              launch,
              observation.turnId,
              observation.finalText,
            ),
          };
          const screenshot = join(
            run.runRoot,
            "screenshots",
            `${safeSegment(step.id, "step")}-restart.png`,
          );
          await launch.page.screenshot(screenshot);
          observation.screenshots.push(screenshot);
        }
      }
    }
    await stopCurrent();
    const evidence = successEvidence({
      launches,
      observations,
      options,
      providerRequests: providerProxy.observations(),
      run,
    });
    writeEvidence(run.evidencePath, evidence);
    return { ...evidence, evidencePath: run.evidencePath };
  } catch (error) {
    const electronOutput = launch?.output;
    const executorOutput = launch?.executorOutput;
    await stopCurrent().catch(() => undefined);
    await providerProxy?.close().catch(() => undefined);
    const failure = failureEvidence({
      electronOutput,
      error,
      executorOutput,
      launches,
      observations,
      options,
      providerRequests: providerProxy?.observations() ?? [],
      run,
    });
    writeEvidence(run.evidencePath, failure);
    throw new Error(
      `${String(failure.error)}\nEvidence: ${run.evidencePath}`,
      { cause: error },
    );
  } finally {
    await stopCurrent().catch(() => undefined);
    await providerProxy?.close().catch(() => undefined);
  }
}
