import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const contract = JSON.parse(readFileSync(new URL(
  "../../../butler-agent/rust/crates/butler-memory/src/cognition/extraction/contracts-v4.json", import.meta.url,
), "utf8"));

/** Same strict synthetic-conversation fixture as butler-e2e/provider/memory.rs. */
export function smokeProviderReply(body: any, prompt: string, answer: string, calls: { chat: number; memory: number; memorySpeakers: Set<string> }): Response {
  assert.ok(JSON.stringify(body).includes(prompt), "Unexpected stub prompt");
  const format = body.text?.format;
  let text = answer;
  if (format?.name === "memory_meaning_v4") {
    const input = JSON.parse(typeof body.input === "string" ? body.input : body.input[0].content[0].text);
    assert.ok(Array.isArray(input.parts) && input.parts.length > 0, "Missing meaning passages");
    assert.deepEqual(format, { name: "memory_meaning_v4", type: "json_schema", strict: true,
      schema: boundedSchema(contract.meaning_schema, input.parts.length) });
    assert.equal(body.instructions, contract.meaning_instructions);
    assert.ok(input.speaker === "user" || input.speaker === "assistant", "Unexpected meaning source");
    calls.memory++;
    calls.memorySpeakers.add(input.speaker);
    text = JSON.stringify({ status: "processed", entities: [], items: [], attributes: [] });
  } else {
    assert.ok(!format?.name, "Unexpected structured provider request");
    calls.chat++;
  }
  const response = { id: "resp_windows", object: "response", status: "completed", model: "gpt-6-luna",
    output: [{ type: "message", id: "msg_windows", role: "assistant", status: "completed",
      content: [{ type: "output_text", text, annotations: [] }] }],
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } };
  if (!body.stream) return Response.json(response);
  return new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
    { headers: { "content-type": "text/event-stream" } });
}

function boundedSchema(source: any, passages: number): unknown {
  const schema = structuredClone(source);
  const visit = (value: any) => {
    if (!value || typeof value !== "object") return;
    if (value.properties?.evidence?.items) {
      value.properties.evidence.items = { type: "integer", minimum: 0, maximum: passages - 1 };
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(schema);
  return schema;
}
