import { expect, test } from "bun:test";
import {
  GuidedEffectTestFixture,
  reviewedWork,
} from "./support/guided-effect-test-fixture.ts";

test("effect dispatch binds one exact action in the accepted current Plan", async () => {
  const fixture = new GuidedEffectTestFixture();
  try {
    const missingPlan = await fixture.execute({
      work: reviewedWork({ includePlan: false }),
    });
    expect(missingPlan).toMatchObject({
      ok: false,
      error: { code: "effect_work_plan_missing" },
    });
    const staleReview = await fixture.execute({
      work: reviewedWork({ reviewedPlanRevisionId: "old-plan" }),
    });
    expect(staleReview).toMatchObject({
      ok: false,
      error: { code: "effect_plan_review_required" },
    });
    const reviseReview = await fixture.execute({
      work: reviewedWork({ reviewVerdict: "revise" }),
    });
    expect(reviseReview).toMatchObject({
      ok: false,
      error: { code: "effect_plan_review_required" },
    });
    expect(fixture.count()).toBe(0);

    const applied = await fixture.execute();
    expect(applied).toMatchObject({
      ok: true,
      status: "applied",
      replayed: false,
      receipt: {
        workId: "guided-work-1",
        planRevisionId: "plan-revision-1",
        actionKey: "write-report",
        capability: "workspace.file",
        sanitizedTarget: "[workspace]/report.md",
      },
    });
    if (!applied.ok) throw new Error("Expected effect to be applied");
    expect(applied.receipt.effectId).toMatch(/^guided-effect-[a-f0-9]{64}$/);
    expect(applied.receipt.receiptId)
      .toMatch(/^guided-effect-receipt-[a-f0-9]{64}$/);
    expect(applied.receipt.idempotencyKey)
      .toMatch(/^guided-effect-idempotency-[a-f0-9]{64}$/);
    expect(applied.receipt.inputSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(applied.receipt.result).toEqual(applied.result);
    expect(fixture.dispatchCalls).toBe(1);

    const stored = fixture.db.query<{
      sanitized_target: string;
      result_json: string;
      receipt_json: string;
    }, []>(`
      SELECT sanitized_target, result_json, receipt_json
      FROM btcc_guided_effects
    `).get();
    expect(stored?.sanitized_target).toBe("[workspace]/report.md");
    expect(stored?.result_json).toContain('"content":"alpha"');
    expect(stored?.receipt_json).toContain('"sanitizedTarget":"[workspace]/report.md"');
    expect(fixture.journal.listForWork("guided-work-1", 1)).toMatchObject([{
      status: "applied",
      capability: "workspace.file",
      sanitizedTarget: "[workspace]/report.md",
    }]);
    const columns = fixture.db.query<{ name: string }, []>(
      "PRAGMA table_info(btcc_guided_effects)",
    ).all().map((column) => column.name);
    expect(columns).not.toContain("normalized_target");
    expect(columns).not.toContain("input_json");
  } finally {
    fixture.close();
  }
});

test("effect binding rejects missing and ambiguous capability-target actions", async () => {
  const fixture = new GuidedEffectTestFixture();
  try {
    const missing = await fixture.execute({ target: "/private/other.md" });
    expect(missing).toMatchObject({
      ok: false,
      error: { code: "effect_action_not_found" },
    });
    const action = reviewedWork().currentPlan!.actions[0]!;
    const ambiguous = await fixture.execute({
      work: reviewedWork({ actions: [action, { ...action, actionKey: "write-again" }] }),
    });
    expect(ambiguous).toMatchObject({
      ok: false,
      error: { code: "effect_action_ambiguous" },
    });
    expect(fixture.count()).toBe(0);
  } finally {
    fixture.close();
  }
});

test("effect identity rejects non-JSON payload values as ordinary model-loop data", async () => {
  const fixture = new GuidedEffectTestFixture();
  try {
    const invalid = await fixture.execute({
      payload: { hidden: Symbol("not-json") },
    });
    expect(invalid).toMatchObject({
      ok: false,
      status: "rejected",
      error: { code: "effect_request_invalid", recoverable: true },
    });
    expect(fixture.count()).toBe(0);
    expect(fixture.dispatchCalls).toBe(0);
  } finally {
    fixture.close();
  }
});

test("one reviewed action slot replays exact input and rejects a changed request", async () => {
  const fixture = new GuidedEffectTestFixture();
  try {
    const first = await fixture.execute({
      payload: { format: "markdown", content: "alpha" },
    });
    const replay = await fixture.execute({
      payload: { content: "alpha", format: "markdown" },
    });
    expect(first.ok).toBeTrue();
    expect(replay).toMatchObject({
      ok: true,
      status: "applied",
      replayed: true,
      result: first.ok ? first.result : undefined,
    });
    expect(fixture.dispatchCalls).toBe(1);

    const conflict = await fixture.execute({
      payload: { content: "changed", format: "markdown" },
    });
    expect(conflict).toMatchObject({
      ok: false,
      status: "rejected",
      error: { code: "effect_identity_conflict" },
    });
    expect(fixture.dispatchCalls).toBe(1);
  } finally {
    fixture.close();
  }
});

test("full_access and cancellation are checked again immediately before dispatch", async () => {
  const fixture = new GuidedEffectTestFixture();
  try {
    const denied = await fixture.execute({ accessMode: "read_only" });
    expect(denied).toMatchObject({
      ok: false,
      error: { code: "effect_access_denied" },
    });
    expect(fixture.status()).toBeNull();
    expect(fixture.count()).toBe(0);
    expect(fixture.dispatchCalls).toBe(0);

    const controller = new AbortController();
    const cancelled = await fixture.execute({
      signal: controller.signal,
      faultHook(point) {
        if (point === "after_dispatch_marker") controller.abort();
      },
    });
    expect(cancelled).toMatchObject({
      ok: false,
      error: { code: "effect_cancelled" },
    });
    expect(fixture.status()).toBe("prepared");
    expect(fixture.dispatchCalls).toBe(0);

    expect(await fixture.execute()).toMatchObject({ ok: true });
    expect(fixture.dispatchCalls).toBe(1);
  } finally {
    fixture.close();
  }
});

test("adapter dispatch failures remain typed effect data instead of Turn state", async () => {
  const fixture = new GuidedEffectTestFixture();
  try {
    fixture.dispatchMode = "throw";
    const uncertain = await fixture.execute();
    expect(uncertain).toMatchObject({
      ok: false,
      status: "uncertain",
      error: { code: "effect_reconciliation_required", recoverable: true },
    });
    expect(fixture.status()).toBe("uncertain");
  } finally {
    fixture.close();
  }

  const rejectedFixture = new GuidedEffectTestFixture();
  try {
    rejectedFixture.dispatchMode = "not_applied";
    const failed = await rejectedFixture.execute();
    expect(failed).toMatchObject({
      ok: false,
      status: "failed",
      error: { code: "effect_dispatch_failed", recoverable: true },
    });
    expect(rejectedFixture.status()).toBe("failed");
  } finally {
    rejectedFixture.close();
  }
});
