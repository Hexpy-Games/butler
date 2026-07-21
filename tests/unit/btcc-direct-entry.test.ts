import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("BTCC Direct-answer executable ingress", () => {
  test("delivers once and replays without another model call or message", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "butler-btcc-r02-"));
    temporaryRoots.push(dataRoot);
    const harness = resolve(
      import.meta.dir,
      "../../packages/butler-agent/src/interfaces/btcc-harness/run-btcc-harness.ts",
    );

    const child = Bun.spawn([
      process.execPath,
      "run",
      harness,
      "--data",
      dataRoot,
      "--turn",
      "turn-r02-direct",
      "--session",
      "session-r02-direct",
      "--message",
      "안녕? 짧게 인사해줘.",
      "--provider",
      "harness",
      "--model",
      "direct-v1",
      "--effort",
      "medium",
      "--profile-ref",
      "profile:concise",
      "--hot-cache-ref",
      "cache:polite-korean",
      "--replay",
    ], {
      cwd: resolve(import.meta.dir, "../.."),
      stderr: "pipe",
      stdout: "pipe",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);

    const result = JSON.parse(stdout.trim()) as {
      initial: { kind: string; messageId: string };
      replay: { kind: string; messageId: string };
      modelCalls: number;
      selectedModel: { provider: string; model: string; reasoningEffort: string };
    };
    expect(result.initial.kind).toBe("delivered");
    expect(result.replay).toEqual(result.initial);
    expect(result.modelCalls).toBe(1);
    expect(result.selectedModel).toEqual({
      provider: "harness",
      model: "direct-v1",
      reasoningEffort: "medium",
    });

    const db = new Database(join(dataRoot, "runtime", "btcc-successor.sqlite"), {
      readonly: true,
    });
    try {
      const turn = db
        .query<{
          semantic_state: string;
          canonical_assistant_message_id: string;
          model_selection_json: string;
        }, []>(
          `SELECT semantic_state, canonical_assistant_message_id, model_selection_json
           FROM btcc_turns WHERE turn_id = 'turn-r02-direct'`,
        )
        .get();
      const messages = db
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM btcc_messages")
        .get();
      const claims = db
        .query<{ semantic_state: string; status: string }, []>(
          "SELECT semantic_state, status FROM btcc_state_claims ORDER BY rowid",
        )
        .all();
      const outbox = db
        .query<{ status: string; expected_message_id: string }, []>(
          "SELECT status, expected_message_id FROM btcc_delivery_outbox",
        )
        .get();

      expect(turn && {
        semantic_state: turn.semantic_state,
        canonical_assistant_message_id: turn.canonical_assistant_message_id,
      }).toEqual({
        semantic_state: "delivered",
        canonical_assistant_message_id: result.initial.messageId,
      });
      expect(turn && JSON.parse(turn.model_selection_json)).toEqual({
        provider: "harness",
        model: "direct-v1",
        reasoningEffort: "medium",
        controls: { reasoningEffort: "medium" },
        controlsHash: createHash("sha256")
          .update(JSON.stringify({ reasoningEffort: "medium" }))
          .digest("hex"),
      });
      expect(messages?.count).toBe(2);
      expect(outbox).toEqual({
        status: "observed",
        expected_message_id: result.initial.messageId,
      });
      expect(claims).toEqual([
        { semantic_state: "admitted", status: "consumed" },
        { semantic_state: "conception_opening", status: "consumed" },
        { semantic_state: "delivery_committed", status: "consumed" },
      ]);
    } finally {
      db.close();
    }
  });
});
