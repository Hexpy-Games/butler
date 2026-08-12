import { createHash } from "node:crypto";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface TestHarnessAuthority {
  harnessRoot: string;
  jsonlPath: string;
}

export function prepareTestHarnessAuthority(root: string): TestHarnessAuthority {
  const harnessRoot = join(root, "harness");
  const relativeFixtureRoot = "tests/support/agent-benchmark/fixtures/m1-v2";
  cpSync(join(process.cwd(), relativeFixtureRoot), join(harnessRoot, relativeFixtureRoot), {
    recursive: true,
  });
  const provenancePath = join(harnessRoot, relativeFixtureRoot, "provenance.json");
  const provenance = JSON.parse(readFileSync(provenancePath, "utf8")) as {
    authority: { jsonlBasename: string };
    toolCalls: Array<{
      armId: string; timestamp: string; payloadInputBytes: number; payloadInputSha256: string;
    }>;
  };
  const jsonlPath = join(root, "authority.jsonl");
  provenance.authority.jsonlBasename = "authority.jsonl";
  const lines = provenance.toolCalls.map((row) => {
    const fixture = JSON.parse(readFileSync(
      join(harnessRoot, relativeFixtureRoot, `${row.armId}.json`), "utf8",
    )) as { steps: unknown[]; fixtures?: unknown[] };
    const original = {
      model: "openai/gpt-5.6-sol", reasoningEffort: "low",
      steps: fixture.steps, fixtures: fixture.fixtures ?? [],
    };
    const added = JSON.stringify(original, null, 2).split("\n")
      .map((line) => `+${line}`).join("\n");
    const input = `const patch = ${JSON.stringify(`*** Begin Patch\n*** Add File: /tmp/${row.armId}.json\n${added}\n*** End Patch`)};\ntext(await tools.apply_patch(patch));\n`;
    row.payloadInputBytes = Buffer.byteLength(input, "utf8");
    row.payloadInputSha256 = createHash("sha256").update(input).digest("hex");
    return JSON.stringify({
      timestamp: row.timestamp,
      payload: { type: "custom_tool_call", name: "exec", input },
    });
  });
  writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
  writeFileSync(jsonlPath, `${lines.join("\n")}\n`, "utf8");
  return { harnessRoot, jsonlPath };
}
