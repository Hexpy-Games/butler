import { join, relative } from "node:path";
import type {
  AgentAdapter,
  BenchmarkArmPlan,
  BenchmarkObservation,
  LandingValidation,
  PreflightResult,
} from "./contracts.ts";
import { getBenchmarkFixture, materializeFixturePrompt } from "./fixtures.ts";
import { evaluateAdapterResult } from "./evaluators.ts";
import {
  createFailureObservation,
  createGatedBenchmarkObservation,
} from "./checkpoint.ts";
import { prepareArmRoots, sourceIntegrity } from "./isolation.ts";
import {
  materializeEvidenceWorkspace,
  type RepositoryEvidenceSnapshot,
  verifyEvidenceWorkspace,
  verifyRepositoryEvidence,
  inventoryOutputFiles,
} from "./repository-evidence.ts";

export type LandingValidator = (input: { arm: BenchmarkArmPlan; fixture: ReturnType<typeof getBenchmarkFixture> }) => Promise<LandingValidation>;

export interface RunBenchmarkArmInput {
  arm: BenchmarkArmPlan;
  adapter: AgentAdapter;
  preflight: PreflightResult;
  signal: AbortSignal;
  planRunRoot: string;
  harnessRoot: string;
  landingValidator: LandingValidator;
  evidenceSnapshot: RepositoryEvidenceSnapshot | null;
  sourceDiagnostic: string | null;
  evidenceDiagnostic: string | null;
}

export async function runBenchmarkArm(input: RunBenchmarkArmInput): Promise<BenchmarkObservation> {
  const { arm, preflight, evidenceSnapshot, sourceDiagnostic, evidenceDiagnostic } = input;
  if (sourceDiagnostic || (evidenceDiagnostic && arm.scenario === "butler_landing_page")) {
    return createGatedBenchmarkObservation(arm, {
      available: false,
      executable: preflight.executable,
      version: preflight.version,
      authenticated: preflight.authenticated,
      configVerified: false,
      gateCode: "configuration_unverifiable",
      diagnostic: sourceDiagnostic ?? evidenceDiagnostic ?? "Landing evidence is unavailable.",
    });
  }
  if (!preflight.available || preflight.gateCode !== "none") return createGatedBenchmarkObservation(arm, preflight);
  const fixture = getBenchmarkFixture(arm.scenario, input.harnessRoot);
  try {
    prepareArmRoots(arm);
  } catch (error) {
    return createFailureObservation(arm, errorMessage(error));
  }
  const sourceBefore = sourceIntegrity(arm.sourceRoot);
  if (sourceBefore.commit !== arm.sourceRevision || sourceBefore.status !== "") {
    return createGatedBenchmarkObservation(arm, {
      available: false,
      executable: preflight.executable,
      version: preflight.version,
      authenticated: preflight.authenticated,
      configVerified: false,
      gateCode: "configuration_unverifiable",
      diagnostic: "Pinned source checkout changed before this arm started.",
    });
  }
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  input.signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (evidenceSnapshot) {
      const beforeEvidence = verifyRepositoryEvidence(evidenceSnapshot);
      if (!beforeEvidence.ok) return createGatedBenchmarkObservation(arm, {
        available: false,
        executable: preflight.executable,
        version: preflight.version,
        authenticated: preflight.authenticated,
        configVerified: false,
        gateCode: "configuration_unverifiable",
        diagnostic: beforeEvidence.diagnostic,
      });
      if (arm.scenario === "butler_landing_page" && arm.agent !== "butler") {
        materializeEvidenceWorkspace(evidenceSnapshot, arm.outputRoot);
        const workspaceEvidence = verifyEvidenceWorkspace(evidenceSnapshot, arm.outputRoot);
        if (!workspaceEvidence.ok) return createGatedBenchmarkObservation(arm, {
          available: false,
          executable: preflight.executable,
          version: preflight.version,
          authenticated: preflight.authenticated,
          configVerified: false,
          gateCode: "configuration_unverifiable",
          diagnostic: workspaceEvidence.diagnostic ?? "External workspace repository evidence could not be verified.",
        });
      }
    }
    const beforeFiles = inventoryOutputFiles(arm.outputRoot);
    let adapterResult = await input.adapter.run({
      arm,
      fixture,
      prompt: materializeFixturePrompt(fixture),
      sessionId: null,
      sourceEvidenceRoot: arm.scenario === "butler_landing_page" ? evidenceSnapshot?.root ?? "" : "",
      runtimeInstructions: runtimeInstructions(arm, arm.scenario === "butler_landing_page" ? evidenceSnapshot?.root ?? "" : "", arm.scenario === "butler_landing_page" ? evidenceSnapshot?.sha256 ?? "" : ""),
      signal: controller.signal,
    });
    const afterFiles = inventoryOutputFiles(arm.outputRoot);
    if (evidenceSnapshot) {
      const afterEvidence = verifyRepositoryEvidence(evidenceSnapshot);
      if (!afterEvidence.ok) {
        return evaluateAdapterResult(arm, fixture, {
          ...adapterResult,
          gateCode: "configuration_unverifiable",
          stderr: afterEvidence.diagnostic ?? "Pinned repository evidence changed.",
        }, { diagnostics: [afterEvidence.diagnostic ?? "Pinned repository evidence changed."] });
      }
      if (arm.scenario === "butler_landing_page" && arm.agent !== "butler") {
        const workspaceEvidence = verifyEvidenceWorkspace(evidenceSnapshot, arm.outputRoot);
        if (!workspaceEvidence.ok) {
          return evaluateAdapterResult(arm, fixture, {
            ...adapterResult,
            gateCode: "configuration_unverifiable",
            stderr: workspaceEvidence.diagnostic ?? "External workspace repository evidence changed.",
          }, { diagnostics: [workspaceEvidence.diagnostic ?? "External workspace repository evidence changed."] });
        }
      }
    }
    const changedPaths = [...new Set([
      ...afterFiles.filter((path) => !beforeFiles.includes(path)),
      ...beforeFiles.filter((path) => !afterFiles.includes(path)),
    ])];
    adapterResult = {
      ...adapterResult,
      changedPaths,
      operations: { ...adapterResult.operations, changedFiles: changedPaths.length },
    };
    if (arm.scenario === "butler_landing_page") {
      const landingValidation = await input.landingValidator({ arm, fixture });
      adapterResult = {
        ...adapterResult,
        landingValidation,
        operations: {
          ...adapterResult.operations,
          changedFiles: changedPaths.length,
          build: { ran: landingValidation.buildPassed !== null, passed: landingValidation.buildPassed, command: "npm run build" },
          tests: { ran: landingValidation.testPassed !== null, passed: landingValidation.testPassed, command: "npm run test" },
        },
        evidenceRefs: [
          ...adapterResult.evidenceRefs,
          ...(landingValidation.desktop.screenshotRef ? [relative(input.planRunRoot, join(arm.evidenceRoot, landingValidation.desktop.screenshotRef))] : []),
          ...(landingValidation.mobile.screenshotRef ? [relative(input.planRunRoot, join(arm.evidenceRoot, landingValidation.mobile.screenshotRef))] : []),
        ],
      };
      if (evidenceSnapshot && arm.agent !== "butler") {
        const validationEvidence = verifyEvidenceWorkspace(evidenceSnapshot, arm.outputRoot);
        if (!validationEvidence.ok) {
          return evaluateAdapterResult(arm, fixture, {
            ...adapterResult,
            gateCode: "configuration_unverifiable",
            stderr: validationEvidence.diagnostic ?? "External workspace repository evidence changed during landing validation.",
          }, { diagnostics: [validationEvidence.diagnostic ?? "External workspace repository evidence changed during landing validation."] });
        }
      }
    }
    if (evidenceSnapshot) {
      const postValidationEvidence = verifyRepositoryEvidence(evidenceSnapshot);
      if (!postValidationEvidence.ok) {
        return evaluateAdapterResult(arm, fixture, {
          ...adapterResult,
          gateCode: "configuration_unverifiable",
          stderr: postValidationEvidence.diagnostic ?? "Pinned repository evidence changed during landing validation.",
        }, { diagnostics: [postValidationEvidence.diagnostic ?? "Pinned repository evidence changed during landing validation."] });
      }
    }
    const sourceAfter = sourceIntegrity(arm.sourceRoot);
    const sourceMutation = sourceIntegrityChanged(sourceBefore, sourceAfter);
    return evaluateAdapterResult(arm, fixture, adapterResult, {
      sourceMutation,
      repositoryEvidenceRoot: evidenceSnapshot?.root,
      diagnostics: sourceMutation ? ["pinned-source-checkout-mutated"] : [],
    });
  } catch (error) {
    return createFailureObservation(arm, errorMessage(error));
  } finally {
    input.signal.removeEventListener("abort", onAbort);
  }
}

export function runtimeInstructions(arm: BenchmarkArmPlan, evidenceRoot: string, evidenceSha256: string): string {
  const outputRule = "Write generated files only to the current isolated workspace root outside .benchmark-input; the Butler harness copies project artifacts into the benchmark output after verification.";
  const repositoryRule = arm.scenario === "butler_landing_page"
    ? `Use the pinned repository evidence under the read-only relative namespace .benchmark-input/repository for repository claims (snapshot ${evidenceSha256 || "hash recorded by the benchmark"}). Generated files such as README.md and package.json belong at the workspace root, not inside that input namespace.`
    : "This scenario has no repository evidence input; do not read or write repository files.";
  void evidenceRoot;
  return `${repositoryRule} ${outputRule} Keep credentials, transcripts, tool payloads, and hidden reasoning out of files.`;
}

function sourceIntegrityChanged(
  before: { commit: string | null; status: string | null } | null,
  after: { commit: string | null; status: string | null } | null,
): boolean {
  if (!before || !after || before.commit === null || after.commit === null || before.status === null || after.status === null) return true;
  return before.status !== "" || after.commit !== before.commit || after.status !== before.status;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
