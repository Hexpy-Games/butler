import { Database } from "bun:sqlite";
import type {
  DurableWorkView,
} from "../../../packages/butler-agent/src/agent/btcc/durable-work/index.ts";
import {
  createGuidedEffectService,
  type EffectAdapter,
  type EffectReconciliation,
  type GuidedEffectFaultHook,
} from "../../../packages/butler-agent/src/agent/btcc/effects/index.ts";
import { SqliteGuidedEffectJournal } from
  "../../../packages/butler-agent/src/agent/adapters/btcc/sqlite/index.ts";
import { BTCC_SUCCESSOR_SCHEMA } from
  "../../../packages/butler-agent/src/agent/adapters/btcc/sqlite/schema.ts";

type NormalizedInput = Record<string, unknown>;
type EffectResult = {
  target: string;
  payload: NormalizedInput;
  sequence: number;
};

export class GuidedEffectTestFixture {
  readonly db = new Database(":memory:");
  readonly journal: SqliteGuidedEffectJournal;
  readonly external = new Map<string, EffectResult>();
  dispatchCalls = 0;
  reconcileCalls = 0;
  dispatchMode: "applied" | "throw" | "not_applied" | "uncertain" = "applied";
  reconcileMode: "observe" | "uncertain" | "not_applied" = "observe";
  readonly adapter: EffectAdapter<NormalizedInput, EffectResult>;

  constructor() {
    this.db.exec(BTCC_SUCCESSOR_SCHEMA);
    this.journal = new SqliteGuidedEffectJournal(this.db);
    this.adapter = {
      capability: "workspace.file",
      normalizeTarget: normalizeTarget,
      sanitizeTarget: (target) => `[workspace]/${target.split("/").at(-1)}`,
      normalizeInput: (input) => {
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          throw new Error("payload must be an object");
        }
        return input as NormalizedInput;
      },
      dispatch: async (input) => {
        this.dispatchCalls += 1;
        if (this.dispatchMode === "throw") {
          throw new Error("transport ended before acknowledgement");
        }
        if (this.dispatchMode === "not_applied") {
          return {
            status: "not_applied",
            error: { code: "target_rejected", message: "Target rejected the request." },
          };
        }
        if (this.dispatchMode === "uncertain") {
          return {
            status: "uncertain",
            error: { code: "timeout", message: "Target acknowledgement timed out." },
          };
        }
        const result = {
          target: input.normalizedTarget,
          payload: input.normalizedInput,
          sequence: this.dispatchCalls,
        };
        this.external.set(input.idempotencyKey, result);
        return { status: "applied", result };
      },
      reconcile: async (input): Promise<EffectReconciliation<EffectResult>> => {
        this.reconcileCalls += 1;
        if (this.reconcileMode === "uncertain") {
          return {
            status: "uncertain",
            error: { code: "target_busy", message: "Target observation is inconclusive." },
          };
        }
        if (this.reconcileMode === "not_applied") return { status: "not_applied" };
        const result = this.external.get(input.idempotencyKey);
        return result ? { status: "applied", result } : { status: "not_applied" };
      },
    };
  }

  service(faultHook?: GuidedEffectFaultHook) {
    return createGuidedEffectService(this.journal, {
      now: () => "2026-07-31T00:00:00.000Z",
      ...(faultHook ? { faultHook } : {}),
    });
  }

  execute(input: {
    work?: DurableWorkView;
    accessMode?: "full_access" | "ask_first" | "read_only";
    signal?: AbortSignal;
    target?: string;
    payload?: Record<string, unknown>;
    faultHook?: GuidedEffectFaultHook;
  } = {}) {
    return this.service(input.faultHook).execute({
      work: input.work ?? reviewedWork(),
      accessMode: input.accessMode ?? "full_access",
      signal: input.signal ?? new AbortController().signal,
      target: input.target ?? "/private/report.md",
      input: input.payload ?? { content: "alpha", format: "markdown" },
      adapter: this.adapter,
    });
  }

  status(): string | null {
    return this.db.query<{ status: string }, []>(`
      SELECT status FROM btcc_guided_effects ORDER BY created_at LIMIT 1
    `).get()?.status ?? null;
  }

  count(): number {
    return this.db.query<{ count: number }, []>(`
      SELECT COUNT(*) AS count FROM btcc_guided_effects
    `).get()?.count ?? 0;
  }

  close(): void {
    this.db.close();
  }
}

export function reviewedWork(input: {
  reviewVerdict?: "accept" | "revise" | "partial";
  reviewedPlanRevisionId?: string;
  actions?: DurableWorkView["currentPlan"] extends infer T
    ? T extends { actions: infer A } ? A : never
    : never;
  includePlan?: boolean;
  includeReview?: boolean;
} = {}): DurableWorkView {
  const plan = {
    planRevisionId: "plan-revision-1",
    revision: 1,
    objective: "Create the report",
    actions: input.actions ?? [{
      actionKey: "write-report",
      description: "Write the requested report",
      dependencyKeys: ["an intentionally unchecked dependency"],
      effect: { capability: "workspace.file", target: "./private/report.md" },
    }],
    checks: [],
    originTurnId: "turn-1",
    createdAt: "2026-07-31T00:00:00.000Z",
  };
  const review = {
    reviewRevisionId: "review-revision-1",
    revision: 1,
    subject: "plan" as const,
    verdict: input.reviewVerdict ?? "accept",
    summary: "The current effect target is safe to execute.",
    corrections: [],
    boundPlanRevisionId: input.reviewedPlanRevisionId ?? plan.planRevisionId,
    boundResultRefs: [],
    originTurnId: "turn-1",
    createdAt: "2026-07-31T00:00:01.000Z",
  };
  return {
    workId: "guided-work-1",
    sessionId: "session-1",
    scope: { kind: "session", sessionId: "session-1" },
    origin: { turnId: "turn-1", messageId: "message-1" },
    objective: "Create the report",
    status: "open",
    ...(input.includePlan === false ? {} : { currentPlan: plan }),
    ...(input.includeReview === false ? {} : { latestPlanReview: review }),
    resultRefs: [],
    createdAt: "2026-07-31T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:01.000Z",
  };
}

function normalizeTarget(value: string): string {
  const compact = value.trim().replace(/^\.?\/*/, "");
  return `/${compact.replace(/\/+/g, "/")}`;
}
