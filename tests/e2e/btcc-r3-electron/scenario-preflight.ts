import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
} from "node:path";
import {
  BTCC_R3_ELECTRON_SCENARIO_SCHEMA,
  type ElectronScenario,
  type PreparedRun,
} from "./contracts.ts";

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function safeSegment(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return normalized || fallback;
}

export function isInside(parent: string, candidate: string): boolean {
  const diff = relative(canonicalPath(parent), canonicalPath(candidate));
  return diff === "" || (!diff.startsWith("..") && !isAbsolute(diff));
}

function canonicalPath(candidate: string): string {
  let existing = resolve(candidate);
  const missingSegments: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missingSegments.unshift(basename(existing));
    existing = parent;
  }
  return resolve(realpathSync(existing), ...missingSegments);
}

export function resolveFixturePath(root: string, candidate: string): string {
  assert(candidate.trim(), "Fixture path is empty.");
  assert(!isAbsolute(candidate), `Fixture path must be relative: ${candidate}`);
  const output = resolve(root, candidate);
  assert(isInside(root, output), `Fixture path escapes workspace: ${candidate}`);
  return output;
}

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export function parseJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function validateElectronScenario(value: unknown): ElectronScenario {
  assert(isRecord(value), "Electron scenario must be an object.");
  assert(
    value.schema === BTCC_R3_ELECTRON_SCENARIO_SCHEMA,
    `Electron scenario schema must be ${BTCC_R3_ELECTRON_SCENARIO_SCHEMA}.`,
  );
  assert(typeof value.id === "string" && value.id.trim(), "Scenario id is required.");
  assert(Array.isArray(value.steps), "Scenario steps must be an array.");
  const scenario = value as unknown as ElectronScenario;
  const sessionKind = scenario.session?.kind;
  if (sessionKind !== undefined) {
    assert(
      sessionKind === "chat" || sessionKind === "project",
      "Scenario session kind must be chat or project.",
    );
  }
  if (scenario.session?.projectDisplayName !== undefined) {
    assert(
      sessionKind === "project" &&
        typeof scenario.session.projectDisplayName === "string" &&
        Boolean(scenario.session.projectDisplayName.trim()),
      "Scenario projectDisplayName requires a non-empty project session.",
    );
  }
  if (scenario.modelFallback !== undefined) {
    assert(
      typeof scenario.modelFallback.enabled === "boolean" &&
        Array.isArray(scenario.modelFallback.models),
      "Scenario modelFallback must contain enabled and models.",
    );
    for (const model of scenario.modelFallback.models) {
      assert(
        typeof model === "string" && model.includes("/"),
        `Scenario fallback model must be provider-qualified: ${String(model)}`,
      );
    }
  }
  if (scenario.providerFixture !== undefined) {
    assert(
      Array.isArray(scenario.providerFixture.responses),
      "Scenario providerFixture responses must be an array.",
    );
    if (scenario.providerFixture.retryAttempts !== undefined) {
      assert(
        Number.isSafeInteger(scenario.providerFixture.retryAttempts) &&
          scenario.providerFixture.retryAttempts > 0 &&
          scenario.providerFixture.retryAttempts <= 5,
        "Scenario providerFixture retryAttempts must be between 1 and 5.",
      );
    }
    for (const response of [
      ...scenario.providerFixture.responses,
      ...(scenario.providerFixture.defaultResponse
        ? [scenario.providerFixture.defaultResponse]
        : []),
    ]) {
      assert(
        response && typeof response === "object",
        "Scenario providerFixture response must be an object.",
      );
      if (response.requestModel !== undefined) {
        assert(
          typeof response.requestModel === "string" && response.requestModel.trim(),
          "Scenario providerFixture requestModel must be non-empty.",
        );
      }
      if (response.status !== undefined) {
        assert(
          Number.isSafeInteger(response.status) && response.status >= 100 && response.status <= 599,
          "Scenario providerFixture status must be an HTTP status.",
        );
      }
      if (response.delayMs !== undefined) {
        assert(
          Number.isSafeInteger(response.delayMs) &&
            response.delayMs >= 0 &&
            response.delayMs <= 5_000,
          "Scenario providerFixture delayMs must be between 0 and 5000.",
        );
      }
    }
  }
  for (const step of scenario.steps) {
    assert(step && typeof step === "object", "Scenario step must be an object.");
    assert(typeof step.id === "string" && step.id.trim(), "Scenario step id is required.");
    assert(
      typeof step.prompt === "string" && step.prompt.trim(),
      `Scenario step ${step.id} prompt is required.`,
    );
    if (step.timeoutMs !== undefined) {
      assert(
        Number.isSafeInteger(step.timeoutMs) && step.timeoutMs > 0,
        `Scenario step ${step.id} timeoutMs must be a positive integer.`,
      );
    }
    if (step.stopAfterAcknowledgement !== undefined) {
      assert(
        typeof step.stopAfterAcknowledgement === "boolean",
        `Scenario step ${step.id} stopAfterAcknowledgement must be a boolean.`,
      );
    }
    for (const file of step.expect?.files ?? []) {
      assert(
        typeof file.path === "string",
        `Scenario step ${step.id} expected file path is invalid.`,
      );
    }
    const minimumRevision = step.expect?.work?.planRevisionAtLeast;
    if (minimumRevision !== undefined) {
      assert(
        Number.isSafeInteger(minimumRevision) && minimumRevision > 0,
        `Scenario step ${step.id} planRevisionAtLeast must be positive.`,
      );
    }
  }
  const stepIds = scenario.steps.map((step) => step.id);
  assert(new Set(stepIds).size === stepIds.length, "Scenario step ids must be unique.");
  const prior = new Set<string>();
  for (const step of scenario.steps) {
    const comparison = step.expect?.work?.sameWorkAsStep;
    if (comparison) {
      assert(
        prior.has(comparison),
        `Scenario step ${step.id} sameWorkAsStep must reference an earlier step.`,
      );
    }
    prior.add(step.id);
  }
  return scenario;
}

export function readElectronScenario(path: string): ElectronScenario {
  return validateElectronScenario(parseJsonFile(resolve(path)));
}

export function materializePrompt(prompt: string, run: PreparedRun): string {
  const replacements: Record<string, string> = {
    DATA_ROOT: run.dataRoot,
    WORKSPACE: run.workspaceRoot,
  };
  const unknown = [...prompt.matchAll(/\{\{([A-Z0-9_]+)\}\}/gu)]
    .map((match) => match[1]!)
    .filter((key) => !(key in replacements));
  assert(
    unknown.length === 0,
    `Unknown prompt fixture(s): ${[...new Set(unknown)].join(", ")}`,
  );
  return prompt.replace(
    /\{\{([A-Z0-9_]+)\}\}/gu,
    (_match, key: string) => replacements[key]!,
  );
}
