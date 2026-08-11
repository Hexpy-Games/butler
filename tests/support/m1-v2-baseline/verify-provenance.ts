#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadCanonicalM1V2Fixtures } from "./fixtures.ts";

interface ProvenanceRow {
  armId: string;
  timestamp: string;
  payloadInputBytes: number;
  payloadInputSha256: string;
}

export function verifyM1V2AuthoritativeProvenance(input: {
  jsonlPath: string;
  repoRoot: string;
}): Record<string, unknown> {
  const provenance = JSON.parse(readFileSync(join(
    input.repoRoot,
    "tests/support/m1-v2-baseline/provenance.json",
  ), "utf8")) as {
    authority: { jsonlBasename: string };
    toolCalls: ProvenanceRow[];
  };
  if (basename(input.jsonlPath) !== provenance.authority.jsonlBasename) {
    throw new Error("Authoritative M1 v2 JSONL basename does not match provenance.");
  }
  const expectedByTimestamp = new Map(provenance.toolCalls.map((row) => [row.timestamp, row]));
  const recovered = new Map<string, Record<string, unknown>>();
  for (const line of readFileSync(input.jsonlPath, "utf8").split("\n")) {
    if (!line) continue;
    const event = JSON.parse(line) as Record<string, unknown>;
    const timestamp = typeof event.timestamp === "string" ? event.timestamp : "";
    const expected = expectedByTimestamp.get(timestamp);
    if (!expected) continue;
    const payload = recordValue(event.payload);
    if (payload?.type !== "custom_tool_call" || payload.name !== "exec" ||
      typeof payload.input !== "string") {
      throw new Error(`Authoritative tool call shape changed: ${timestamp}`);
    }
    const payloadBytes = Buffer.byteLength(payload.input, "utf8");
    const payloadSha256 = digest(payload.input);
    if (payloadBytes !== expected.payloadInputBytes ||
      payloadSha256 !== expected.payloadInputSha256) {
      throw new Error(`Authoritative payload bytes changed: ${timestamp}`);
    }
    recovered.set(expected.armId, JSON.parse(recoverAddedFile(payload.input)));
  }
  const fixtures = loadCanonicalM1V2Fixtures(input.repoRoot);
  for (const fixture of fixtures) {
    const original = recovered.get(fixture.armId);
    if (!original) throw new Error(`Authoritative fixture missing: ${fixture.armId}`);
    if (original.model !== "openai/gpt-5.6-sol" || original.reasoningEffort !== "low") {
      throw new Error(`Original model provenance changed: ${fixture.armId}`);
    }
    const originalSteps = recordArray(original.steps);
    for (const step of fixture.scenario.steps) {
      const source = originalSteps.find((candidate) => candidate.id === step.id);
      if (source?.prompt !== step.prompt) {
        throw new Error(`Canonical prompt differs from authority: ${fixture.armId}/${step.id}`);
      }
    }
    const originalFiles = recordArray(original.fixtures);
    for (const file of fixture.scenario.fixtures ?? []) {
      const source = originalFiles.find((candidate) => candidate.path === file.path);
      if (source?.text !== file.text) {
        throw new Error(`Canonical landing bytes differ from authority: ${file.path}`);
      }
    }
  }
  return {
    ok: true,
    authority: provenance.authority.jsonlBasename,
    recovered: provenance.toolCalls.map((row) => ({
      armId: row.armId,
      timestamp: row.timestamp,
      payloadInputBytes: row.payloadInputBytes,
      payloadInputSha256: row.payloadInputSha256,
      promptSha256: fixtures.find((fixture) => fixture.armId === row.armId)?.promptSha256,
      fixtureSha256: fixtures.find((fixture) => fixture.armId === row.armId)?.fixtureSha256,
    })),
    originalReasoningEffort: "low",
    canonicalReasoningEffort: "medium",
    promptAndLandingFixtureBytesChanged: false,
  };
}

function recoverAddedFile(input: string): string {
  const marker = "const patch = ";
  const start = input.indexOf(marker);
  if (start < 0) throw new Error("Authoritative tool call has no patch declaration.");
  const literalStart = start + marker.length;
  if (input[literalStart] !== '"') throw new Error("Patch declaration is not a JSON string.");
  let escaped = false;
  let literalEnd = -1;
  for (let index = literalStart + 1; index < input.length; index += 1) {
    const character = input[index]!;
    if (!escaped && character === '"') {
      literalEnd = index + 1;
      break;
    }
    escaped = !escaped && character === "\\";
    if (character !== "\\") escaped = false;
  }
  if (literalEnd < 0) throw new Error("Patch string is unterminated.");
  const patch = JSON.parse(input.slice(literalStart, literalEnd)) as string;
  const lines = patch.split("\n");
  const add = lines.findIndex((line) => line.startsWith("*** Add File: "));
  const end = lines.indexOf("*** End Patch");
  if (add < 0 || end <= add) throw new Error("Patch does not contain one added fixture.");
  return `${lines.slice(add + 1, end).map((line) => {
    if (!line.startsWith("+")) throw new Error("Added fixture patch line is invalid.");
    return line.slice(1);
  }).join("\n")}\n`;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

if (import.meta.main) {
  const index = process.argv.indexOf("--jsonl");
  const jsonlPath = index >= 0 ? process.argv[index + 1] : undefined;
  if (!jsonlPath) throw new Error("Usage: verify-provenance.ts --jsonl FILE");
  console.log(JSON.stringify(verifyM1V2AuthoritativeProvenance({
    jsonlPath,
    repoRoot: process.cwd(),
  }), null, 2));
}
