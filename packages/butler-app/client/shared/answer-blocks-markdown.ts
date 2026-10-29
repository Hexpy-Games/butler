import type { AnswerBlock, AnswerBlocks, CardItem, CardValue } from "./app-contracts.ts";

/** Preserve plain block text without letting it introduce Markdown syntax. */
function text(value: string | number | null | undefined): string {
  return String(value ?? "").replace(/\\/g, "\\\\")
    .replace(/[\n\r]+/g, " ").replace(/([`*_{}[\]()<>#+.!|~-])/g, "\\$1");
}

function link(label: string, source?: string): string {
  if (!source) return text(label);
  try {
    const url = new URL(source);
    if (url.protocol !== "http:" && url.protocol !== "https:") return text(label);
    const destination = url.href.replace(/[()<>\\]/g, c => `%${c.charCodeAt(0).toString(16)}`);
    return `[${text(label)}](${destination})`;
  } catch {
    return text(label);
  }
}

function provenance(item: { source?: string; checked?: string }): string {
  return [item.source ? link(item.source, item.source) : "", item.checked ? text(item.checked) : ""]
    .filter(Boolean).join(" · ");
}

function amount(value: CardValue): string {
  const unit = value.cur ?? value.unit;
  return [value.amount, unit].filter(v => v !== undefined).map(text).join(" ");
}

function card(item: CardItem): string {
  const lines = [`- ${link(item.title, item.source)}`];
  const detail = [item.label, item.sub].filter(Boolean).map(text).join(" · ");
  if (detail) lines.push(`  ${detail}`);
  if (item.img) lines.push(`  ${text(item.img)}`);
  if (item.value) {
    const previous = item.value.was === undefined ? "" : ` (~~${amount({ ...item.value, amount: item.value.was })}~~)`;
    lines.push(`  ${amount(item.value)}${previous}${item.value.note ? ` · ${text(item.value.note)}` : ""}`);
  }
  for (const fact of item.facts ?? []) lines.push(`  - ${text(fact)}`);
  if (item.text) lines.push(`  ${text(item.text)}`);
  const source = provenance(item);
  if (source) lines.push(`  ${source}`);
  return lines.join("\n");
}

function table(columns: string[], rows: (string | number | null)[][]): string {
  const row = (cells: (string | number | null)[]) => `| ${cells.map(text).join(" | ")} |`;
  return [row(columns), row(columns.map(() => "---")).replace(/\\-/g, "-"), ...rows.map(row)].join("\n");
}

function blockMarkdown(block: AnswerBlock, imageUrl: (url?: string) => string | undefined): string {
  switch (block.type) {
    case "columns": case "group": return block.blocks.map(child => titledBlock(child, imageUrl)).join("\n\n");
    case "tabs": return block.tabs.map(tab => `### ${text(tab.label)}\n\n${tab.blocks.map(child => titledBlock(child, imageUrl)).join("\n\n")}`).join("\n\n");
    case "timeline": return block.items.map(item => `- **${text(item.when)}** ${text(item.title)}${item.text ? ` — ${text(item.text)}` : ""}`).join("\n");
    case "checklist": return block.items.map(item => `- [${item.done ? "x" : " "}] ${text(item.text)}`).join("\n");
    case "progress": return block.items.map(item => `${text(item.label)}: ${item.value} / ${item.max ?? 100}${item.unit ? ` ${text(item.unit)}` : ""}`).join("\n");
    case "text": return block.text;
    case "quote": return `> ${text(block.text)}${block.cite ? ` — ${text(block.cite)}` : ""}`;
    case "image": return `![${text(block.caption)}](${imageUrl((block as AnswerBlock & { image_url?: string }).image_url) ?? ""})`;
    case "cards": return block.items.map(card).join("\n");
    case "table": return table(block.columns, block.rows);
    case "gallery": return block.items.map(item => `- ${link(item.caption ?? item.img, item.source)} · ${text(item.img)}`).join("\n");
    case "facts": return block.items.map(item => `- ${text(item.label)}: ${text(item.value)}${provenance(item) ? ` · ${provenance(item)}` : ""}`).join("\n");
    case "metrics": return block.items.map(item => `- ${text(item.label)}: ${text(item.value)}${item.unit ? ` ${text(item.unit)}` : ""}${item.delta ? ` (${text(item.delta)})` : ""}${provenance(item) ? ` · ${provenance(item)}` : ""}`).join("\n");
    case "chart": return [table(["", ...block.series.map(s => s.name)], block.x.map((x, i) => [x, ...block.series.map(s => s.values[i])])), block.unit ? text(block.unit) : "", provenance(block)].filter(Boolean).join("\n");
    case "callout": return `> ${text(block.text)}`;
    case "actions": return block.items.map(item => "ask" in item ? `> 질문 제안: ${text(item.ask)}` : `- ${link(item.label, item.open)}`).join("\n");
  }
}

function titledBlock(block: AnswerBlock, imageUrl: (url?: string) => string | undefined): string {
  return [block.title ? `### ${text(block.title)}` : "", blockMarkdown(block, imageUrl)].filter(Boolean).join("\n\n");
}

/** Portable copy/export representation, resolving decorated image URLs as the renderer does. */
export function toMarkdown(spec: AnswerBlocks, imageUrl: (url?: string) => string | undefined = url => url): string {
  return spec.blocks.map(block => titledBlock(block, imageUrl)).join("\n\n");
}
