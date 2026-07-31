import type {
  EffectAdapter,
  GuidedEffectAccessMode,
  GuidedEffectService,
} from "../../btcc/effects/index.ts";
import type {
  DurableWorkService,
  WorkTurnScope,
} from "../../btcc/durable-work/index.ts";
import type {
  ButlerToolCall,
  ButlerToolExecutionBoundary,
} from "../../tools/butler-tools.ts";

export type GuidedPersistentEffectRequest = {
  target: string;
  input: unknown;
  adapter: EffectAdapter<unknown, unknown>;
};

export function createGuidedToolExecutionBoundary(input: {
  durableWork: DurableWorkService;
  workScope: WorkTurnScope;
  effectService: GuidedEffectService;
  accessMode: GuidedEffectAccessMode;
  signal: AbortSignal;
  executeCommand(call: ButlerToolCall): Promise<unknown>;
  resolvePersistentEffect(
    call: ButlerToolCall,
    execute: () => Promise<unknown>,
  ): GuidedPersistentEffectRequest | null;
}): ButlerToolExecutionBoundary {
  return async ({ call, definition, execute }) => {
    if (definition.effectBoundary === "none" ||
        definition.effectBoundary === "turn_local") {
      return execute();
    }
    if (definition.effectBoundary === "dynamic") {
      if (call.name === "tool_call") return execute();
      if (call.name === "run_command") return input.executeCommand(call);
      return unavailableEffect(call.name);
    }
    const request = input.resolvePersistentEffect(call, execute);
    if (!request) return unavailableEffect(call.name);
    const work = await loadEffectWork(input.durableWork, input.workScope);
    if (!work) {
      return ordinaryEffectError(
        "effect_work_required",
        "Create concise Work, record its Plan Review, then retry this persistent effect.",
      );
    }
    const outcome = await input.effectService.execute({
      work,
      accessMode: input.accessMode,
      signal: call.signal ?? input.signal,
      target: request.target,
      input: request.input,
      adapter: request.adapter,
    });
    if (!outcome.ok) {
      return ordinaryEffectError(outcome.error.code, outcome.error.message, {
        effect_status: outcome.status,
      });
    }
    return withReceipt(outcome.result, {
      receipt_id: outcome.receipt.receiptId,
      capability: outcome.receipt.capability,
      target: outcome.receipt.sanitizedTarget,
      applied_at: outcome.receipt.appliedAt,
      replayed: outcome.replayed,
    });
  };
}

async function loadEffectWork(
  service: DurableWorkService,
  scope: WorkTurnScope,
) {
  try {
    return await service.boundWorkForTurn(scope.turnId) ??
      await service.bindOpenWork(scope);
  } catch {
    return null;
  }
}

function unavailableEffect(toolName: string): Record<string, unknown> {
  return ordinaryEffectError(
    "effect_adapter_unavailable",
    `${toolName} cannot make persistent or external changes in this R3 runtime. Use an available typed effect tool or report the limitation.`,
  );
}

function ordinaryEffectError(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ok: false,
    error: {
      code,
      message,
      recoverable: true,
      next_action: "Amend or review the current Plan, choose a safe typed tool, or report the concrete limitation.",
      ...details,
    },
  };
}

function withReceipt(
  result: unknown,
  receipt: Record<string, unknown>,
): Record<string, unknown> {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    return {
      ...result as Record<string, unknown>,
      effect_receipt: receipt,
    };
  }
  return { ok: true, result, effect_receipt: receipt };
}
