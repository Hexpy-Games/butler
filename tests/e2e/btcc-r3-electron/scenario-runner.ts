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
  productLaunchFailureDiagnostics,
  openSession,
  stopProduct,
  type ProductLaunch,
} from "./product-launch.ts";
import {
  startProviderObservationProxy,
  type ProviderObservationProxy,
  type ProviderRequestObservation,
} from "./provider-observation-proxy.ts";
import {
  assert,
  safeSegment,
  validateElectronScenario,
} from "./scenario-preflight.ts";
import {
  runScenarioStep,
  verifyDurableCancelled,
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
    agentOwnership: run.agentOwnership,
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
  let runError: unknown;
  let runFailed = false;
  let electronOutput: string[] | undefined;
  let executorOutput: string[] | undefined;
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
      fixture: scenario.providerFixture,
    });
    launch = await launchProduct(run, providerProxy.endpoint);
    launches.push({
      electronPid: launch.child.pid ?? null,
      executorPid: launch.executorPid,
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
        executorPid: launch.executorPid,
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
        const observation = await runScenarioStep(
          run,
          launch,
          step,
          prior,
          providerProxy,
        );
        observations.push(observation);
        prior.set(step.id, observation);
        if (step.restartAfter === true) {
          await stopCurrent();
          launch = await launchProduct(run, providerProxy.endpoint);
          launches.push({
            electronPid: launch.child.pid ?? null,
            executorPid: launch.executorPid,
            interruptedExecutorReplaced: false,
            startedAtMs: launch.startedAtMs,
            stoppedAtMs: null,
          });
          observation.restart = {
            tested: true,
            finalMatched: observation.terminalState === "cancelled"
              ? await verifyDurableCancelled(run, launch, observation.turnId)
              : await verifyDurableFinal(
                run,
                launch,
                observation.turnId,
                observation.finalText,
              ),
          };
          const providerAgentModelsAfterRestart = providerProxy.observations()
            .filter((request) => request.requestKind === "agent")
            .map((request) => request.requestedModel)
            .filter((model): model is string => Boolean(model));
          observation.restart.providerAgentModels = providerAgentModelsAfterRestart;
          if (
            providerAgentModelsAfterRestart.length !== observation.providerAgentModels.length ||
            providerAgentModelsAfterRestart.some(
              (model, index) => model !== observation.providerAgentModels[index],
            )
          ) {
            observation.expectations.failures.push(
              `provider_agent_models_changed_after_restart:${providerAgentModelsAfterRestart.join(",")}`,
            );
            observation.expectations.passed = false;
          }
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
  } catch (error) {
    runFailed = true;
    runError = error;
    electronOutput = launch?.output;
    executorOutput = launch?.executorOutput;
    if (!electronOutput || !executorOutput) {
      const diagnostics = productLaunchFailureDiagnostics(error);
      electronOutput ??= diagnostics.electronOutput.length > 0
        ? diagnostics.electronOutput
        : undefined;
      executorOutput ??= diagnostics.executorOutput.length > 0
        ? diagnostics.executorOutput
        : undefined;
    }
  }

  let cleanupError: unknown;
  electronOutput ??= launch?.output;
  executorOutput ??= launch?.executorOutput;
  try {
    await stopCurrent();
  } catch (error) {
    cleanupError = error;
    await stopCurrent().catch(() => undefined);
  }
  let providerRequests: ProviderRequestObservation[] = [];
  if (providerProxy) {
    try {
      providerRequests = await providerProxy.close();
    } catch (error) {
      cleanupError ??= error;
      providerRequests = providerProxy.observations();
    }
  }
  if (!runFailed && cleanupError !== undefined) {
    runFailed = true;
    runError = cleanupError;
  }

  if (runFailed) {
    const failure = failureEvidence({
      electronOutput,
      error: runError,
      executorOutput,
      launches,
      observations,
      options,
      providerRequests,
      run,
    });
    writeEvidence(run.evidencePath, failure);
    throw new Error(
      `${String(failure.error)}\nEvidence: ${run.evidencePath}`,
      { cause: runError },
    );
  }

  const evidence = successEvidence({
    bindingWorkspace: bindingWorkspace(run),
    launches,
    observations,
    options,
    providerRequests,
    run,
  });
  writeEvidence(run.evidencePath, evidence);
  return { ...evidence, evidencePath: run.evidencePath };
}
