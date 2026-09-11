import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentConversationStore } from "../../packages/butler-agent/src/agent/conversation/store.ts";
import { initializeEmptyMemoryGeneration } from "../../packages/butler-agent/src/agent/cognition/memory/projection/generation.ts";
import { ingestConversationMemory } from "../../packages/butler-agent/src/agent/cognition/memory/projection/ingestion.ts";
import { createContextEvidenceResolver } from "../../packages/butler-agent/src/agent/cognition/memory/projection/context-evidence.ts";
import {
  openProjectionDb,
  type ProjectionSourceRow,
} from "../../packages/butler-agent/src/agent/cognition/memory/projection/store.ts";
import type { ExtractInput } from "../../packages/butler-agent/src/agent/cognition/memory/projection/contracts.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function fixture(
  secondText = "العربية 日本語 끝  ",
  firstText = "  앞말 ",
) {
  const root = mkdtempSync(join(tmpdir(), "memory-context-evidence-"));
  roots.push(root);
  const descriptor = initializeEmptyMemoryGeneration(root);
  const store = new AgentConversationStore({ butlerData: root });
  const turn = store.beginTurn({
    gateway: "app",
    externalSessionId: "session",
    sessionId: "session",
    projectId: null,
    actor: "user",
    turnId: "turn",
  });
  const user = store.appendUserMessage({
    sessionId: "session",
    turnId: turn.id,
    text: "",
    originKind: "user_input",
    originRef: "app:turn:user",
    parts: [
      { kind: "text", contentJson: { text: firstText } },
      { kind: "text", contentJson: { text: secondText } },
    ],
  });
  const assistant = store.appendAssistantMessage({
    sessionId: "session",
    turnId: turn.id,
    text: "확인했습니다.",
    originKind: "assistant_public",
    originRef: "app:turn:assistant",
  });
  store.finalizeTurn({
    turnId: turn.id,
    status: "complete",
    outcomeCapsule: {
      sessionId: "session",
      turnId: turn.id,
      generation: 1,
      outcome: "delivered",
      requestMessageId: user.id,
      publicAssistantMessageId: assistant.id,
      providerId: "test",
      modelRef: "test/model",
    },
  });
  store.close();
  await ingestConversationMemory({
    context: {
      butlerData: root,
      target: { kind: "active", expected_generation: descriptor.generation_id },
      signal: new AbortController().signal,
    },
    source: {
      kind: "conversation_turn",
      session_id: "session",
      turn_id: turn.id,
      outcome_generation: 1,
    },
  });
  const db = openProjectionDb(
    join(
      root,
      "cognition/memory/generations",
      descriptor.generation_id,
      "graph.sqlite",
    ),
  );
  const sources = db
    .query<
      ProjectionSourceRow,
      [string]
    >("SELECT * FROM memory_chunk_sources WHERE conversation_message_id=? ORDER BY part_id,byte_start")
    .all(user.id);
  const current = db
    .query<
      ProjectionSourceRow,
      [string]
    >("SELECT * FROM memory_chunk_sources WHERE conversation_message_id=?")
    .get(assistant.id)!;
  const input: ExtractInput = {
    schema: "butler.memory-extract-input.v2",
    episode_ref: current.episode_id,
    revision: current.revision,
    window_ref: "window",
    bound_project_id: null,
    source_units: [
      {
        ref: current.source_id,
        text: "확인했습니다.",
        role: "assistant",
        origin_kind: "assistant_public",
        observed_at: current.observed_at,
      },
    ],
    context_units: [
      {
        ref: `conversation-message:${user.id}`,
        text: "앞말  العربية 日本語 끝",
        basis: "user_statement",
        observed_at: sources[0]!.observed_at,
      },
    ],
    candidates: [],
  };
  return {
    root,
    db,
    input,
    first: sources.find((row) => row.part_id === user.parts[0]!.id)!,
    second: sources.find((row) => row.part_id === user.parts[1]!.id)!,
    secondRows: sources.filter((row) => row.part_id === user.parts[1]!.id),
  };
}

function quote(input: ExtractInput, text: string) {
  const unit = input.context_units[0]!;
  const start = unit.text.indexOf(text);
  if (start < 0) throw new Error("fixture quote missing");
  const byteStart = Buffer.byteLength(unit.text.slice(0, start));
  return {
    sourceId: unit.ref,
    byteStart,
    byteEnd: byteStart + Buffer.byteLength(text),
    quote: text,
  };
}

test("maps multilingual message context across real parts and trimmed suffixes", async () => {
  const { root, db, input, first, second } = await fixture();
  try {
    const resolve = createContextEvidenceResolver(db, root, input);
    expect(resolve(quote(input, "말  العربية"))).toEqual([
      {
        sourceId: first.source_id,
        byteStart: Buffer.byteLength("  앞"),
        byteEnd: Buffer.byteLength("  앞말 "),
        quote: "말 ",
      },
      {
        sourceId: second.source_id,
        byteStart: 0,
        byteEnd: Buffer.byteLength("العربية"),
        quote: "العربية",
      },
    ]);
    input.context_units[0]!.text = "日本語 끝";
    expect(
      createContextEvidenceResolver(db, root, input)(quote(input, "日本語")),
    ).toEqual([
      {
        sourceId: second.source_id,
        byteStart: Buffer.byteLength("العربية "),
        byteEnd: Buffer.byteLength("العربية 日本語"),
        quote: "日本語",
      },
    ]);
    input.context_units[0] = {
      ...input.context_units[0]!,
      ref: second.source_id,
      text: "日本語 끝  ",
    };
    expect(
      createContextEvidenceResolver(db, root, input)(quote(input, "끝")),
    ).toEqual([
      {
        sourceId: second.source_id,
        byteStart: Buffer.byteLength("العربية 日本語 "),
        byteEnd: Buffer.byteLength("العربية 日本語 끝"),
        quote: "끝",
      },
    ]);
  } finally {
    db.close();
  }
});

test("rejects changed context, scope, source hashes and missing canonical spans", async () => {
  const { root, db, input, second } = await fixture();
  try {
    const changed = structuredClone(input);
    changed.context_units[0]!.text = "다른 문맥";
    expect(() =>
      createContextEvidenceResolver(db, root, changed)(quote(changed, "문맥")),
    ).toThrow("memory_source_changed");
    expect(() =>
      createContextEvidenceResolver(db, root, {
        ...input,
        bound_project_id: "different-project",
      })(quote(input, "日本語")),
    ).toThrow("memory_source_changed");
    for (const sql of [
      "UPDATE memory_chunk_sources SET content_hash='changed' WHERE source_id=?",
      "DELETE FROM memory_chunk_sources WHERE source_id=?",
    ]) {
      db.exec("BEGIN");
      try {
        db.query(sql).run(second.source_id);
        expect(() =>
          createContextEvidenceResolver(
            db,
            root,
            input,
          )(quote(input, "日本語")),
        ).toThrow("memory_source_changed");
      } finally {
        db.exec("ROLLBACK");
      }
    }
  } finally {
    db.close();
  }
});

test("splits one context quote at canonical UTF-8 source slice boundaries", async () => {
  const { root, db, input, secondRows } = await fixture(
    "a".repeat(8190) + "日本語終",
    "",
  );
  try {
    // The canonical splitter records the boundary-crossing grapheme separately.
    expect(secondRows.map((row) => [row.byte_start, row.byte_end])).toEqual([
      [0, 8190],
      [8190, 8193],
      [8193, 8202],
    ]);
    input.context_units[0]!.text = "aa日本語終";
    expect(
      createContextEvidenceResolver(db, root, input)(quote(input, "aa日本語")),
    ).toEqual([
      {
        sourceId: secondRows[0]!.source_id,
        byteStart: 8188,
        byteEnd: 8190,
        quote: "aa",
      },
      {
        sourceId: secondRows[1]!.source_id,
        byteStart: 0,
        byteEnd: Buffer.byteLength("日"),
        quote: "日",
      },
      {
        sourceId: secondRows[2]!.source_id,
        byteStart: 0,
        byteEnd: Buffer.byteLength("本語"),
        quote: "本語",
      },
    ]);
  } finally {
    db.close();
  }
});
