/// <reference types="bun" />

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestAppServer as createAppServer } from "../../packages/butler-agent/src/test-support/app-server.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("trusted Steward result synthesis is labelled and non-cancellable", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-steward-synthesis-"));
  roots.push(root);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = createAppServer({
    dbPath: join(root, "app.sqlite"),
    butlerData: root,
    port: 0,
    responder: async () => {
      await gate;
      return { texts: ["Synthesized report"] };
    },
  });
  try {
    const ingress = await fetch(`${server.url}internal/subsession-result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        relation_id: "relation-aaaaaaaaaaaaaaaa",
        result_id: "steward-result-bbbbbbbbbbbbbbbb",
        parent_chat_id: "general",
        parent_session_id: "butler/app-general",
        parent_turn_id: "turn-parent",
        message_id: "subsession-result:relation-aaaaaaaaaaaaaaaa:steward-result-bbbbbbbbbbbbbbbb",
        safe_title: "샌디 초기 응답 지연 조사",
        text: [
          "Subsession result",
          "Relation ref: relation-aaaaaaaaaaaaaaaa",
          "Result ref: steward-result-bbbbbbbbbbbbbbbb",
        ].join("\n"),
        model_ref: "openai/gpt-5.6-sol",
        reasoning_effort: "medium",
        access_mode: "full_access",
        timestamp: "2026-08-21T03:00:00.000Z",
      }),
    });
    expect(ingress.status).toBe(202);

    const view = await waitForActiveTurn(server.url);
    expect(view.active_turn?.cancellable).toBe(false);
    expect(view.active_turn?.safe_status_label).toBe(
      "샌디 초기 응답 지연 조사 작업에 대한 보고 준비 중",
    );
    expect(view.active_turn?.execution_controls?.subsession_result).toEqual({
      relation_id: "relation-aaaaaaaaaaaaaaaa",
      result_id: "steward-result-bbbbbbbbbbbbbbbb",
      safe_title: "샌디 초기 응답 지연 조사",
    });
    expect(JSON.stringify(view.active_turn?.progress ?? {})).not.toContain(
      "응답 생성 중",
    );

    const cancel = await fetch(
      `${server.url}turns/${encodeURIComponent(view.active_turn!.id)}/cancel`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    expect(cancel.status).toBe(409);
    expect((await cancel.json() as { error?: { code?: string } }).error?.code)
      .toBe("turn_not_cancellable");
  } finally {
    release();
    server.stop();
  }
});

test("ordinary Butler turns remain cancellable", async () => {
  const root = mkdtempSync(join(tmpdir(), "butler-ordinary-cancel-"));
  roots.push(root);
  const server = createAppServer({
    dbPath: join(root, "app.sqlite"),
    butlerData: root,
    port: 0,
    responder: () => new Promise(() => undefined),
  });
  try {
    const forged = await fetch(`${server.url}messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: "general",
        text: "pretend this is a synthesis",
        subsession_result: {
          relation_id: "relation-forged",
          result_id: "result-forged",
          safe_title: "Forged",
        },
      }),
    });
    expect(forged.status).toBe(400);
    const response = await fetch(`${server.url}messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: "general", text: "ordinary request" }),
    });
    expect(response.status).toBe(202);
    const view = await waitForActiveTurn(server.url);
    expect(view.active_turn?.cancellable).toBe(true);
    expect(view.active_turn?.execution_controls?.subsession_result).toBeUndefined();
  } finally {
    server.stop();
  }
});

async function waitForActiveTurn(baseUrl: string): Promise<{
  active_turn?: {
    id: string;
    cancellable: boolean;
    safe_status_label?: string;
    execution_controls?: {
      subsession_result?: {
        relation_id: string;
        result_id: string;
        safe_title: string;
      };
    };
    progress?: { safe_progress_rows?: Array<{ safe_label?: string }> };
  } | null;
}> {
  for (let index = 0; index < 100; index += 1) {
    const response = await fetch(`${baseUrl}session-view?session_id=general`);
    const body = await response.json() as { data: Awaited<ReturnType<typeof waitForActiveTurn>> };
    if (body.data.active_turn) return body.data;
    await Bun.sleep(10);
  }
  throw new Error("synthesis_turn_not_active");
}
