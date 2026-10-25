// Invoked by the single Rust fixture table, without a second test suite.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Project } from "ts-morph";
import type { AnswerBlocks } from "../../packages/butler-app/client/shared/app-contracts.ts";
import { toMarkdown } from "../../packages/butler-app/client/shared/answer-blocks-markdown.ts";

interface Rule {
  $ref?: string;
  const?: string | number;
  enum?: (string | number)[];
  type?: string | string[];
  oneOf?: Rule[];
  not?: { required: string[] };
  properties?: Record<string, Rule>;
  required?: string[];
  items?: Rule;
  $defs?: Record<string, Rule>;
}

const base = "packages/butler-agent/rust/crates/butler-runtime/";
const schema: Rule = JSON.parse(readFileSync(`${base}src/capabilities/catalog/answer-blocks.schema.json`, "utf8"));
const names: Record<string, string> = {
  id: "AnswerBlockId", title: "AnswerBlockTitle", source: "AnswerSource", checked: "Checked",
  img: "AssetId", media: "AnswerMedia", value: "CardValue", card: "CardItem", cell: "AnswerCell", block: "AnswerBlock", leaf: "AnswerLeafBlock",
};

function type(rule: Rule): string {
  if (rule.$ref) return names[rule.$ref.split("/").at(-1)!];
  if (rule.const !== undefined) return JSON.stringify(rule.const);
  if (rule.enum) return rule.enum.map(v => JSON.stringify(v)).join(" | ");
  if (rule.oneOf) return rule.oneOf.map(type).join(" | ");
  if (Array.isArray(rule.type)) return rule.type.join(" | ");
  if (rule.type === "array") return `Array<${type(rule.items!)}>`;
  if (rule.type === "object") {
    const excluded = rule.not?.required ?? [];
    const fields = Object.entries(rule.properties!).filter(([key]) => !excluded.includes(key));
    const object = `{ ${fields.map(([key, value]) => `${key}${rule.required?.includes(key) ? "" : "?"}: ${type(value)};`).join(" ")} }`;
    if (!excluded.length) return object;
    const alternatives = excluded.map(selected => `{ ${excluded.map(key => `${key}?: ${key === selected ? type(rule.properties![key]) : "never"};`).join(" ")} }`);
    return `${object} & (${alternatives.join(" | ")})`;
  }
  return rule.type as string;
}

const project = new Project({ useInMemoryFileSystem: true });
const actual = project.createSourceFile("actual.ts", readFileSync("packages/butler-app/client/shared/app-contracts.ts", "utf8"));
const expectedTypes: Record<string, string> = {};
for (const key of Object.keys(schema.$defs!)) {
  names[key] ??= `${key[0].toUpperCase()}${key.slice(1)}Block`;
}
for (const [key, rule] of Object.entries(schema.$defs!)) expectedTypes[names[key]] = type(rule);
expectedTypes.AnswerBlocks = type(schema);
for (const [name, definition] of Object.entries(expectedTypes)) {
  const expected = project.createSourceFile(`${name}.ts`, `type ${name} = ${definition};`);
  const normalize = (s: string) => s.replace(/\s/g, "").replace(/;}/g, "}");
  assert.equal(normalize(actual.getTypeAliasOrThrow(name).getTypeNodeOrThrow().getText()),
    normalize(expected.getTypeAliasOrThrow(name).getTypeNodeOrThrow().getText()), `${name} must mirror the JSON Schema`);
}
const fixtures = JSON.parse(readFileSync("packages/butler-agent/rust/crates/butler-e2e/tests/answer_blocks/fixtures.json", "utf8"));
for (const entry of fixtures.cases) {
  if (!entry.accept) continue;
  const spec = fixtures.specs[entry.spec] as AnswerBlocks;
  assert.equal(toMarkdown(spec), fixtures.markdown[entry.spec], `${entry.name}: complete Markdown`);
}
console.log(`${Object.keys(expectedTypes).length} mirrored types; accepted fixture Markdown matches`);
