import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ElectronPage } from "../../../../tests/support/electron-page-cdp.ts";
import { bridge, waitFor } from "./installer-smoke-support.ts";
import { smokeProviderReply, type SmokeProviderCalls } from "./smoke-provider.ts";

const prompt = "다운로드 폴더 정리해줘";
const answer = "다운로드 목록을 확인했습니다: 보고서.txt, 사진.png. 이동 전에 승인을 받겠습니다.";
const command = 'Get-ChildItem -LiteralPath "$env:USERPROFILE\\Downloads" | Sort-Object Name | Select-Object -ExpandProperty Name';
export interface DownloadsProof { requests: number; stdout?: string }

/** Deterministic model fixture; the released Agent executes the actual command. */
export function releasedDownloadsReply(body: any, proof: DownloadsProof, calls: SmokeProviderCalls): Response | null {
  const text = JSON.stringify(body);
  if (!text.includes(prompt) && !text.includes(answer)) return null;
  if (body.text?.format) return smokeProviderReply(body, text.includes(prompt) ? prompt : answer, answer, calls);
  const result = body.input?.find((item: any) => item.type === "function_call_output" && item.call_id === "call_downloads");
  if (result) {
    const value = JSON.parse(result.output);
    const output = value.output && typeof value.output === "object" ? value.output : value;
    assert.equal(output.exit_code, 0, result.output);
    assert.equal(output.sandbox, "unisolated", "The model must see the actual Windows execution mode");
    assert.deepEqual(output.stdout.trim().split(/\r?\n/u).map((line: string) => line.trim()), ["보고서.txt", "사진.png"]);
    proof.stdout = output.stdout;
  }
  proof.requests++;
  assert.equal(proof.requests, result ? 2 : 1, "Unexpected Downloads tool round");
  const item = result ? { type: "message", id: "msg_downloads", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: answer, annotations: [] }] } : {
    type: "function_call", id: "fc_downloads", call_id: "call_downloads", name: "run_command", status: "completed",
    arguments: JSON.stringify({ command, summary: "다운로드 목록 확인", state_effect: "read_only", timeout_ms: 30000 }),
  };
  const response = { id: `resp_downloads_${proof.requests}`, object: "response", status: "completed", model: "gpt-6-luna",
    output: [item], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } };
  if (!body.stream) return Response.json(response);
  const events = [
    { type: "response.created", response: { id: response.id, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item },
    ...(result ? [{ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: answer }] : [
      { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 0, delta: item.arguments },
      { type: "response.function_call_arguments.done", item_id: item.id, output_index: 0, arguments: item.arguments },
    ]),
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ];
  return new Response(events.map((event, sequence_number) =>
    `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(""),
  { headers: { "content-type": "text/event-stream" } });
}

export async function proveReleasedDownloads(page: ElectronPage, home: string, proof: DownloadsProof) {
  const downloads = join(home, "Downloads");
  mkdirSync(downloads, { recursive: true });
  writeFileSync(join(downloads, "보고서.txt"), "document");
  writeFileSync(join(downloads, "사진.png"), "image");
  await bridge(page, "updateSettings", { access_mode: "full_access" });
  const session = (await bridge(page, "createSession", { kind: "chat", title: "Released Downloads command" })).session;
  await bridge(page, "sendMessage", { chatId: session.id, text: prompt, clientMessageId: crypto.randomUUID() });
  await waitFor(async () => (await bridge(page, "listTurns", { chatId: session.id })).turns.some(
    (turn: any) => turn.state === "delivered"), "released Downloads command turn");
  const messages = (await bridge(page, "listMessages", { chatId: session.id })).messages;
  assert.ok(messages.some((message: any) => message.role === "user" && message.text === prompt));
  assert.ok(messages.some((message: any) => message.role === "assistant" && message.text === answer));
  assert.equal(proof.requests, 2);
  assert.ok(proof.stdout, "The model never received the Downloads listing");
  assert.deepEqual(readdirSync(downloads).sort(), ["보고서.txt", "사진.png"]);
  assert.equal(readFileSync(join(downloads, "보고서.txt"), "utf8"), "document");
  assert.equal(readFileSync(join(downloads, "사진.png"), "utf8"), "image");
  console.log(JSON.stringify({ releasedDownloadsChat: true, prompt, command, toolRounds: proof.requests,
    files: ["보고서.txt", "사진.png"], dataPreserved: true }));
}
