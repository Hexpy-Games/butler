import schema from "../../../butler-agent/rust/crates/butler-runtime/src/capabilities/catalog/answer-blocks.schema.json";
import type { AnswerBlockView, AnswerBlocksView } from "./answer-blocks-view";

type Rule = { $ref?: string; const?: unknown; enum?: unknown[]; type?: string | string[];
  oneOf?: Rule[]; required?: string[]; properties?: Record<string, Rule>; items?: Rule;
  minimum?: number; exclusiveMinimum?: number; minItems?: number; maxItems?: number; minLength?: number; maxLength?: number;
  pattern?: string; format?: string; not?: { required: string[] } };
const definitions = schema.$defs as unknown as Record<string, Rule>;
const invalid = Symbol("invalid");
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scalar(value: unknown, rule: Rule): unknown {
  const types = Array.isArray(rule.type) ? rule.type : [rule.type];
  if (rule.type && !types.includes(value === null ? "null" : typeof value)) return invalid;
  if (typeof value === "number" && !Number.isFinite(value)) return invalid;
  if (typeof value === "number" && (value < (rule.minimum ?? -Infinity) || value <= (rule.exclusiveMinimum ?? -Infinity))) return invalid;
  if (typeof value !== "string") return value;
  const length = [...value].length;
  if (length < (rule.minLength ?? 0) || length > (rule.maxLength ?? Infinity)) return invalid;
  if (rule.pattern && !new RegExp(rule.pattern, "u").test(value)) return invalid;
  if (rule.format === "date-time" && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || !Number.isFinite(Date.parse(value)))) return invalid;
  if (rule === definitions.source) {
    try { if (!["http:", "https:"].includes(new URL(value).protocol)) return invalid; }
    catch { return invalid; }
  }
  return value;
}

/** The schema's subset, with unknown keys ignored and invalid array items dropped. */
function parse(value: unknown, rule: Rule): unknown {
  if (rule.$ref) return parse(value, definitions[rule.$ref.split("/").at(-1)!]);
  if (rule.const !== undefined && value !== rule.const) return invalid;
  if (rule.enum && !rule.enum.includes(value)) return invalid;
  if (rule.oneOf) {
    for (const candidate of rule.oneOf) {
      const result = parse(value, candidate);
      if (result !== invalid) return result;
    }
    return invalid;
  }
  if (rule.type === "array") {
    if (!Array.isArray(value) || value.length > (rule.maxItems ?? Infinity)) return invalid;
    const itemRule = rule.items!.$ref ? definitions[rule.items!.$ref.split("/").at(-1)!] : rule.items!;
    const parsed = value.map(item => parse(item, rule.items!));
    // Cells, axis labels and series values retain their positions; only whole items may be dropped.
    if (parsed.includes(invalid) && itemRule.type !== "object" && itemRule.type !== "array" && !itemRule.oneOf) return invalid;
    const items = parsed.filter(item => item !== invalid);
    return items.length >= (rule.minItems ?? 0) ? items : invalid;
  }
  if (rule.type === "object") {
    if (!object(value) || rule.not?.required.every(key => key in value)) return invalid;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(rule.properties ?? {})) {
      if (!(key in value)) continue;
      const parsed = parse(value[key], child);
      if (parsed === invalid && (child.minimum !== undefined || child.exclusiveMinimum !== undefined)) return invalid;
      if (parsed !== invalid) result[key] = parsed;
    }
    // HTTP decoration is transport metadata, outside the model-facing spec.
    if (typeof result.img === "string" && typeof value.image_url === "string"
      && value.image_url.startsWith(`/message-assets/${encodeURIComponent(result.img)}?`)
      && /^\/message-assets\/img_[a-z0-9]{10,12}\?expires=\d+&signature=[a-zA-Z0-9_-]+$/u.test(value.image_url)) {
      result.image_url = value.image_url;
      for (const key of ["image_width", "image_height"]) {
        if (typeof value[key] === "number" && Number.isFinite(value[key]) && value[key] > 0) result[key] = value[key];
      }
    }
    return rule.required?.some(key => !(key in result)) ? invalid : result;
  }
  return scalar(value, rule);
}

function block(value: unknown): AnswerBlockView | null {
  const parsed = parse(value, definitions.block);
  if (parsed === invalid) return null;
  const result = parsed as AnswerBlockView;
  if (result.type === "columns" || result.type === "group") result.blocks = result.blocks.map(block).filter(item => item !== null) as typeof result.blocks;
  if (result.type === "tabs") result.tabs = result.tabs.map(tab => ({ ...tab, blocks: tab.blocks.map(block).filter(item => item !== null) as typeof tab.blocks })).filter(tab => tab.blocks.length > 0);
  if (result.type === "progress") result.items = result.items.filter(item => item.value <= (item.max ?? 100));
  if (result.type === "table") result.rows = result.rows.filter(row => row.length === result.columns.length);
  if (result.type === "chart") result.series = result.series.filter(series => series.values.length === result.x.length);
  if (result.type === "table" && !result.rows.length || result.type === "chart" && !result.series.length) return null;
  if (result.type === "progress" && !result.items.length) return null;
  return result;
}

/** Accept old/partial records without exposing validation errors in the conversation. */
export function parseAnswerBlocks(value: unknown): AnswerBlocksView | null {
  if (!object(value) || (value.v !== 1 && value.v !== 2) || !Array.isArray(value.blocks)) return null;
  const blocks = value.blocks.map(block).filter((item): item is AnswerBlockView => item !== null);
  return blocks.length ? { v: value.v, blocks } : null;
}
