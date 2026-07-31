import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { addFeedbackEntry } from "../../packages/butler-agent/src/agent/cognition/feedback/buffer.ts";
import { createKnowHowEntry, readKnowHowEntry } from "../../packages/butler-agent/src/agent/cognition/know-how/store.ts";
import { runScheduledCognitionConsolidation } from "../../packages/butler-agent/src/agent/cognition/consolidation/scheduled-cycle.ts";

test("scheduled cognition consolidation runs generic cycle before legacy memory maintenance", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-scheduled-cognition-"));
  const legacyCalls: string[] = [];
  try {
    const knowhow = createKnowHowEntry(butlerData, {
      name: "scheduled_docs_lookup",
      aliases: ["docs"],
      status: "active",
      summary: "Use docs source for lookups.",
      intent_match: { topics: ["docs"], examples: ["lookup docs"] },
      strategy: { steps: ["query docs"], preferred_sources: ["docs.example.com"] },
    });
    addFeedbackEntry(butlerData, {
      text: "이제 source docs.example.com 쓰지마.",
      targetRef: "source:docs.example.com",
      category: "source_policy",
      scope: "source",
      promotionTarget: "source_quality",
    });

    const result = await runScheduledCognitionConsolidation({
      butlerHome: process.cwd(),
      butlerData,
      runId: "cr_scheduled_test",
      runLegacyMemoryCycle: () => {
        legacyCalls.push(readKnowHowEntry(butlerData, knowhow.knowhow_id)?.status ?? "missing");
        return { status: 0, stderr: "" };
      },
    });

    expect(result).toMatchObject({
      schema: "butler.cognition.scheduled-consolidation.v1",
      status: "completed",
      generic: {
        status: "completed",
      },
      legacy_memory: {
        ok: true,
      },
      raw_text_included: false,
    });
    expect(legacyCalls).toEqual(["disabled"]);
    expect(readKnowHowEntry(butlerData, knowhow.knowhow_id)?.status).toBe("disabled");
    expect(existsSync(result.generic.checkpoint_path)).toBe(true);
    expect(existsSync(result.generic.summary_path)).toBe(true);
    expect(existsSync(join(butlerData, "operational", "butler.sqlite"))).toBe(false);
    expect(existsSync(join(butlerData, "app-server", "butler-client.sqlite"))).toBe(false);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});

test("scheduled cognition consolidation works on a fresh data home", async () => {
  const butlerData = mkdtempSync(join(tmpdir(), "butler-scheduled-cognition-fresh-"));
  try {
    const result = await runScheduledCognitionConsolidation({
      butlerHome: process.cwd(),
      butlerData,
      runId: "cr_scheduled_fresh",
    });

    expect(result.status).toBe("completed");
    expect(result.generic.status).toBe("completed");
    expect(result.legacy_memory.ok).toBe(true);
    expect(existsSync(join(butlerData, "cognition", "memory", "db", "graph.sqlite"))).toBe(true);
    expect(existsSync(result.generic.summary_path)).toBe(true);
  } finally {
    rmSync(butlerData, { recursive: true, force: true });
  }
});
