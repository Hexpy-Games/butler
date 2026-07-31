import {
  applyProjectLedgerRecordUpdates,
  reconcileProjectLedgerRecordUpdates,
} from "../../adapters/index.ts";
import type { EffectAdapter } from "../../btcc/effects/index.ts";
import {
  type ActiveProjectLedgerReference,
  projectLedgerRootInitialized,
} from "../../../integrations/project-ledger/active-project-ledger-reference.ts";
import {
  guidedProjectLedgerEffect,
  type GuidedProjectLedgerEffect,
} from "./guided-project-ledger-effect-input.ts";
import {
  classifyLegacyProjectLedgerEffect,
  normalizeLegacyProjectLedgerUpdates,
} from "./guided-project-ledger-legacy-effect.ts";
export {
  GUIDED_PROJECT_LEDGER_EFFECT_TOOL_NAMES,
  guidedProjectLedgerEffect,
  isGuidedProjectLedgerEffectTool,
  type GuidedProjectLedgerEffect,
} from "./guided-project-ledger-effect-input.ts";

export async function executeGuidedProjectLedgerEffect(input: {
  butlerData: string;
  projectRoot: string;
  effectKey: string;
  effect: GuidedProjectLedgerEffect;
}): Promise<Record<string, unknown>> {
  const result = await applyProjectLedgerRecordUpdates({
    butlerData: input.butlerData,
    projectRoot: input.projectRoot,
    effectKey: input.effectKey,
    updates: input.effect.updates,
  });
  return {
    ok: true,
    effect: "project_ledger_publication",
    publication_id: result.publicationId,
    updated_records: result.updatedRecords,
    source_sha256: result.currentHead.sourceSha256,
    source_file_count: result.currentHead.sourceFileCount,
  };
}

export function createGuidedProjectLedgerEffectAdapter(input: {
  name: string;
  args: Record<string, unknown>;
  butlerData: string;
  projectRoot: string;
  projectRef: string;
  resolveActiveProjectReference(): ActiveProjectLedgerReference;
  initializeForCreate?: () => void | Promise<void>;
}): {
  target: string;
  normalizedInput: Record<string, unknown>;
  adapter: EffectAdapter<Record<string, unknown>, Record<string, unknown>>;
} {
  assertAdmittedProject(input.args, input.projectRef);
  const effect = guidedProjectLedgerEffect(input.name, input.args);
  return {
    target: effect.target,
    normalizedInput: effect.normalizedInput,
    adapter: {
      capability: input.name,
      reviewedPlanBinding: "accepted_plan",
      normalizeTarget: normalizeProjectLedgerTarget,
      sanitizeTarget: normalizeProjectLedgerTarget,
      normalizeInput: normalizeProjectLedgerInput,
      classifyEffectBlocker(blocker) {
        return classifyLegacyProjectLedgerEffect({
          ...blocker,
          currentCapability: input.name,
          projectRoot: input.projectRoot,
        });
      },
      async dispatch({ idempotencyKey, normalizedInput }) {
        const bindingError = projectLedgerMutationBindingError(input);
        if (bindingError) {
          return { status: "not_applied", error: bindingError };
        }
        const updates = projectLedgerUpdates(normalizedInput, effect);
        if (!projectLedgerRootInitialized(input.projectRoot)) {
          if (
            input.name !== "project_ledger_create" ||
            !input.initializeForCreate
          ) {
            return {
              status: "not_applied",
              error: {
                code: "project_ledger_not_initialized",
                message: "The active Project Ledger has no records yet. Create the first reviewed record before using update or completion tools.",
                recoverable: true,
              },
            };
          }
        }
        try {
          await input.initializeForCreate?.();
          const result = await applyProjectLedgerRecordUpdates({
            butlerData: input.butlerData,
            projectRoot: input.projectRoot,
            effectKey: idempotencyKey,
            updates,
          });
          return {
            status: "applied",
            result: publicProjectLedgerResult(result),
          };
        } catch (error) {
          const observed = await reconcileProjectLedgerRecordUpdates({
            butlerData: input.butlerData,
            projectRoot: input.projectRoot,
            effectKey: idempotencyKey,
            updates,
          });
          if (observed.status === "applied") {
            return {
              status: "applied",
              result: publicProjectLedgerResult(observed.result),
            };
          }
          if (observed.status === "not_applied") {
            return {
              status: "not_applied",
              error: adapterError(error),
            };
          }
          return {
            status: "uncertain",
            error: {
              code: "project_ledger_effect_uncertain",
              message: observed.message,
              recoverable: true,
            },
          };
        }
      },
      async reconcile({ idempotencyKey, normalizedInput }) {
        const bindingError = projectLedgerMutationBindingError(input);
        if (bindingError) {
          return { status: "uncertain", error: bindingError };
        }
        const updates = projectLedgerUpdates(normalizedInput, effect);
        if (!projectLedgerRootInitialized(input.projectRoot)) {
          return { status: "not_applied" };
        }
        const reconciled = await reconcileProjectLedgerRecordUpdates({
          butlerData: input.butlerData,
          projectRoot: input.projectRoot,
          effectKey: idempotencyKey,
          updates,
        });
        if (reconciled.status === "not_applied") return reconciled;
        if (reconciled.status === "uncertain") {
          return {
            status: "uncertain",
            error: {
              code: "project_ledger_effect_uncertain",
              message: reconciled.message,
              recoverable: true,
            },
          };
        }
        return {
          status: "applied",
          result: publicProjectLedgerResult(reconciled.result),
        };
      },
    },
  };
}

function projectLedgerMutationBindingError(input: {
  projectRoot: string;
  projectRef: string;
  resolveActiveProjectReference(): ActiveProjectLedgerReference;
}): {
  code: "project_ledger_active_app_binding_required";
  message: string;
  recoverable: true;
} | null {
  try {
    const reference = input.resolveActiveProjectReference();
    if (
      reference.source === "app_project_db" &&
      reference.degradation_code === undefined &&
      reference.app_project_id === input.projectRef &&
      reference.ledger_root === input.projectRoot
    ) {
      return null;
    }
  } catch {
    // A lookup failure is the same safety outcome as a missing exact App row.
  }
  return {
    code: "project_ledger_active_app_binding_required",
    message: "Project Ledger changes require the exact active App project binding. Refresh the project session before retrying.",
    recoverable: true,
  };
}

function projectLedgerUpdates(
  input: Record<string, unknown>,
  current: GuidedProjectLedgerEffect,
): GuidedProjectLedgerEffect["updates"] {
  if (!Array.isArray(input.updates)) return current.updates;
  return normalizeLegacyProjectLedgerUpdates(input.updates);
}

function publicProjectLedgerResult(result: {
  publicationId: string;
  updatedRecords: Array<{ id: string; kind?: string }>;
  currentHead: { sourceSha256: string; sourceFileCount: number };
}): Record<string, unknown> {
  return {
    ok: true,
    effect: "project_ledger_publication",
    publication_id: result.publicationId,
    updated_records: result.updatedRecords,
    source_sha256: result.currentHead.sourceSha256,
    source_file_count: result.currentHead.sourceFileCount,
  };
}

function normalizeProjectLedgerTarget(value: string): string {
  const target = value.trim();
  if (!/^project-ledger:[a-z][a-z0-9_-]*:[A-Za-z0-9._:-]{1,160}$/u.test(target)) {
    throw new Error("Project Ledger effect target must be project-ledger:<kind>:<id>");
  }
  return target;
}

function normalizeProjectLedgerInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Project Ledger effect input must be an object");
  }
  return value as Record<string, unknown>;
}

function assertAdmittedProject(
  args: Record<string, unknown>,
  projectRef: string | undefined,
): void {
  const explicit = optionalString(args.project_ref) ?? optionalString(args.project_path);
  if (explicit && explicit !== projectRef) {
    throw new Error(
      "Project Ledger mutation target differs from the active project. Omit project_ref or use the active project.",
    );
  }
}

function adapterError(error: unknown): {
  code: string;
  message: string;
  recoverable: true;
} {
  return {
    code: error && typeof error === "object" && "code" in error &&
        typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "project_ledger_effect_dispatch_uncertain",
    message: error instanceof Error
      ? error.message
      : "The Project Ledger effect ended without a reliable outcome.",
    recoverable: true,
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
