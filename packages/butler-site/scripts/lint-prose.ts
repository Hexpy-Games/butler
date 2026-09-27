#!/usr/bin/env bun
/**
 * Deterministic prose lint for the Korean manual (src/content/docs/ko/**.mdx).
 * The writing rules live in skills/butler-docs-writing; this script enforces
 * the mechanical subset:
 * - sentence-ending: body sentences end in 합니다체 (headings are exempt; list
 *   items and table cells may be noun phrases without a final period)
 * - banned-phrase: phrases from prose-lint-phrases.json (shared with the skill)
 * - em-dash: no "—" as a sentence connector; list items may use one
 *   "term — definition" dash
 * - emoji: no emoji in prose
 * - mixed-list: one list does not mix sentence items and noun-phrase items
 * - bold-flanking: bold that Markdown cannot close (**…다.**가) and would
 *   render with literal asterisks
 * Frontmatter, code (fenced and inline), JSX/MDX tags and props, expressions
 * and URLs are never read. Bold UI labels and quoted UI strings are opaque to
 * the phrase and sentence rules.
 *
 * Escape hatch (a reason after "--" is required; unused directives fail):
 *   {/* prose-lint-disable-next-line <rule-id>[ <rule-id>] -- <reason> *\/}
 *   ... {/* prose-lint-disable-line <rule-id> -- <reason> *\/}
 * A single phrase is disabled with banned-phrase/<phrase-id>.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SITE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const PHRASES_PATH = join(SITE_ROOT, "scripts", "prose-lint-phrases.json");
export const SKILL_PHRASES_REFERENCE = join(SITE_ROOT, "skills", "butler-docs-writing", "references", "banned-phrases.md");
export const KO_DOCS_ROOT = join(SITE_ROOT, "src", "content", "docs", "ko");

export type ProseRule =
  | "sentence-ending"
  | "banned-phrase"
  | "em-dash"
  | "emoji"
  | "mixed-list"
  | "bold-flanking"
  | "disable-syntax"
  | "unused-disable";

const DISABLEABLE: ProseRule[] = ["sentence-ending", "banned-phrase", "em-dash", "emoji", "mixed-list", "bold-flanking"];

export interface ProseFinding {
  path: string;
  line: number;
  rule: ProseRule;
  /** Phrase id for banned-phrase findings. */
  id?: string;
  message: string;
}

export interface BannedPhrase {
  id: string;
  pattern: string;
  message: string;
  example: string;
}

export function loadBannedPhrases(path = PHRASES_PATH): BannedPhrase[] {
  return (JSON.parse(readFileSync(path, "utf8")) as { phrases: BannedPhrase[] }).phrases;
}

// ---------------------------------------------------------------- masking

/** Removed characters; stripped before analysis so offsets survive masking. */
const GONE = "\u0000";
/** Placeholders that read as one opaque word. */
const CODE = "";
const LABEL = "";
const ELEMENT = "";
const QUOTE = "";
const PLACEHOLDERS = /[-]/gu;

const erase = (text: string) => text.replace(/[^\n]/gu, GONE);
const token = (text: string, placeholder: string) => placeholder + erase(text).slice(1);

interface Directive {
  line: number;
  target: number;
  rules: string[];
  valid: boolean;
  used: boolean;
  problem?: string;
}

function eraseFences(source: string): string {
  let fence: string | null = null;
  return source
    .split("\n")
    .map((line) => {
      const marker = /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
      if (fence) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
        return erase(line);
      }
      if (marker) {
        fence = marker;
        return erase(line);
      }
      return /^(import|export)\s/u.test(line) ? erase(line) : line;
    })
    .join("\n");
}

/** Erases JSX/HTML tags (self-closing ones become one ELEMENT word) and {expressions}. */
function eraseJsx(source: string): string {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (source.startsWith("{/*", index)) {
      // MDX comments may hold apostrophes; they end at the first "*/}".
      const close = source.indexOf("*/}", index);
      const end = close === -1 ? source.length : close + 3;
      out += erase(source.slice(index, end));
      index = end;
      continue;
    }
    const isTag = char === "<" && /[A-Za-z/!]/u.test(source[index + 1] ?? "");
    if (!isTag && char !== "{") {
      out += char;
      index += 1;
      continue;
    }
    let depth = isTag ? 0 : 1;
    let quote: string | null = null;
    let end = index + 1;
    for (; end < source.length; end += 1) {
      const current = source[end];
      if (quote) {
        if (current === quote) quote = null;
      } else if (current === '"' || current === "'" || current === "`") {
        // Apostrophes in tag text are rare; quotes only matter inside props and expressions.
        if (isTag || depth > 0) quote = current;
      } else if (current === "{") depth += 1;
      else if (current === "}") {
        depth -= 1;
        if (!isTag && depth === 0) break;
      } else if (isTag && current === ">" && depth === 0) break;
    }
    const chunk = source.slice(index, end + 1);
    out += isTag && chunk.endsWith("/>") ? token(chunk, ELEMENT) : erase(chunk);
    index = end + 1;
  }
  return out;
}

interface Masked {
  /** Bold labels and quotes are placeholders: input for phrase, sentence and list rules. */
  prose: string[];
  /** Lines that held only markup (JSX tags, fences, comments): block boundaries. */
  walls: boolean[];
  /** Bold markers removed, label text kept: input for the emoji rule. */
  visible: string[];
  /** Lines whose bold span Markdown will not close (CommonMark flanking rules). */
  unclosedBold: number[];
  directives: Directive[];
}

function lineAtOffset(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (source[index] === "\n") line += 1;
  return line;
}

function parseDirectives(source: string, phraseIds: Set<string>): Directive[] {
  const lines = source.split("\n");
  const directives: Directive[] = [];
  for (const match of source.matchAll(/\{\/\*\s*prose-lint-(disable-next-line|disable-line)\b([\s\S]*?)\*\/\}/gu)) {
    const line = lineAtOffset(source, match.index);
    const endLine = lineAtOffset(source, match.index + match[0].length);
    let target = line;
    if (match[1] === "disable-next-line") {
      target = endLine + 1;
      while (target <= lines.length && lines[target - 1].trim() === "") target += 1;
    }
    const [ruleText, ...reasonParts] = match[2].split("--");
    const rules = ruleText.split(/[\s,]+/u).filter(Boolean);
    const reason = reasonParts.join("--").trim();
    const unknown = rules.filter((rule) => {
      const [base, phrase] = rule.split("/");
      if (!DISABLEABLE.includes(base as ProseRule)) return true;
      return phrase !== undefined && (base !== "banned-phrase" || !phraseIds.has(phrase));
    });
    let problem: string | undefined;
    if (rules.length === 0) problem = "names no rule id";
    else if (unknown.length > 0) problem = `unknown rule id ${unknown.join(", ")}`;
    else if (reason.length < 3) problem = 'needs a reason after "--"';
    directives.push({ line, target, rules, valid: !problem, used: false, problem });
  }
  return directives;
}

function mask(source: string, phraseIds: Set<string>): Masked {
  let text = source.replace(/^---\n[\s\S]*?\n---(?=\n|$)/u, erase);
  text = eraseFences(text);
  const directives = parseDirectives(text, phraseIds);
  text = text.replace(/`[^`\n]*`/gu, (code) => token(code, CODE));
  text = eraseJsx(text);
  text = text.replace(/(!?\[)([^\]\n]*)(\]\([^)\n]*\))/gu, (_, open: string, label: string, target: string) =>
    erase(open) + label + erase(target));
  text = text.replace(/<?\b(?:https?:\/\/|mailto:)[^\s)>\]]+>?/gu, (url) => token(url, CODE));
  const bold = /\*\*(?=\S)([^\n]*?\S)\*\*/gu;
  // "**…다.**가": a closing ** after punctuation must be followed by space or
  // punctuation; an opening ** before punctuation must follow space or punctuation.
  const unclosedBold: number[] = [];
  for (const match of text.matchAll(bold)) {
    const before = text[match.index - 1] ?? " ";
    const after = text[match.index + match[0].length] ?? " ";
    const inner = match[1];
    const wordy = /[\p{L}\p{N}]/u;
    const punct = /[\p{P}\p{S}]/u;
    if ((punct.test(inner.at(-1)!) && wordy.test(after)) || (punct.test(inner[0]) && wordy.test(before))) {
      unclosedBold.push(lineAtOffset(text, match.index));
    }
  }
  const visible = text.replace(bold, (_, label: string) => `${GONE}${GONE}${label}${GONE}${GONE}`);
  const prose = text
    .replace(bold, (label) => token(label, LABEL))
    .replace(/"[^"\n]*"|“[^”\n]*”/gu, (quoted) => token(quoted, QUOTE));
  const strip = (value: string) => value.split("\n").map((line) => line.replaceAll(GONE, ""));
  const original = source.split("\n");
  const lines = strip(prose);
  const walls = lines.map((line, index) => line.trim() === "" && original[index].trim() !== "");
  return { prose: lines, walls, visible: strip(visible), unclosedBold, directives };
}

// ---------------------------------------------------------------- structure

interface Piece {
  text: string;
  line: number;
}

interface Unit {
  kind: "paragraph" | "item" | "cell" | "heading";
  pieces: Piece[];
}

interface Item extends Unit {
  kind: "item";
  indent: number;
  contentColumn: number;
  hasChildren: boolean;
}

interface List {
  indent: number;
  ordered: boolean;
  items: Item[];
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/u;

function parse(lines: string[], walls: boolean[]): { units: Unit[]; lists: List[] } {
  const units: Unit[] = [];
  const lists: List[] = [];
  let paragraph: Unit | null = null;
  let stack: List[] = [];
  let previousBlank = true;

  const closeParagraph = () => {
    if (paragraph) units.push(paragraph);
    paragraph = null;
  };
  const closeLists = (indent = -1) => {
    while (stack.length > 0 && stack.at(-1)!.indent > indent) lists.push(stack.pop()!);
  };

  lines.forEach((raw, index) => {
    const line = index + 1;
    const trimmed = raw.trim();
    if (trimmed === "") {
      closeParagraph();
      // A JSX tag line (<Notice>, </Steps>) ends every open list; a blank line may not.
      if (walls[index]) closeLists();
      previousBlank = true;
      return;
    }
    const indent = raw.length - raw.trimStart().length;
    const item = LIST_ITEM.exec(raw);
    if (/^#{1,6}\s/u.test(trimmed)) {
      closeParagraph();
      closeLists();
      units.push({ kind: "heading", pieces: [{ text: trimmed.replace(/^#+\s*/u, ""), line }] });
    } else if (trimmed.startsWith("|")) {
      closeParagraph();
      closeLists();
      if (!/^\|?[\s:|-]+$/u.test(trimmed)) {
        for (const cell of trimmed.replace(/^\||\|$/gu, "").split("|")) {
          units.push({ kind: "cell", pieces: [{ text: cell.trim(), line }] });
        }
      }
    } else if (item) {
      closeParagraph();
      const ordered = /\d/u.test(item[2]);
      closeLists(indent);
      const top = stack.at(-1);
      if (top && top.indent === indent && top.ordered !== ordered) closeLists(indent - 1);
      const parent = stack.at(-1);
      if (parent && parent.indent < indent) parent.items.at(-1)!.hasChildren = true;
      if (!parent || parent.indent < indent) stack.push({ indent, ordered, items: [] });
      const unit: Item = {
        kind: "item",
        pieces: [{ text: item[3].trim(), line }],
        indent,
        contentColumn: indent + item[2].length + 1,
        hasChildren: false,
      };
      stack.at(-1)!.items.push(unit);
      units.push(unit);
    } else {
      const deepest = stack.at(-1)?.items.at(-1);
      if (deepest && (!previousBlank || indent >= deepest.contentColumn) && !paragraph) {
        deepest.pieces.push({ text: trimmed, line });
      } else {
        closeLists();
        if (!paragraph) paragraph = { kind: "paragraph", pieces: [] };
        paragraph.pieces.push({ text: trimmed, line });
      }
    }
    previousBlank = false;
  });
  closeParagraph();
  closeLists();
  return { units, lists };
}

function joined(unit: Unit): { text: string; lineAt: (offset: number) => number } {
  let text = "";
  const starts: Array<[number, number]> = [];
  unit.pieces.forEach((piece, index) => {
    if (index > 0) text += " ";
    starts.push([text.length, piece.line]);
    text += piece.text;
  });
  const lineAt = (offset: number) => {
    let line = starts[0][1];
    for (const [start, pieceLine] of starts) if (offset >= start) line = pieceLine;
    return line;
  };
  return { text, lineAt };
}

// ---------------------------------------------------------------- sentences

interface Segment {
  text: string;
  end: number;
  terminated: boolean;
}

function sentences(text: string): Segment[] {
  const segments: Segment[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (/[.?!]/u.test(text[index]) && (index + 1 === text.length || /\s/u.test(text[index + 1]))) {
      segments.push({ text: text.slice(start, index + 1).trim(), end: index, terminated: true });
      start = index + 1;
    }
  }
  const rest = text.slice(start).trim();
  if (rest) segments.push({ text: rest, end: text.length - 1, terminated: false });
  return segments;
}

const HANGUL = /[가-힣]/u;
const FORMAL_ENDING = /(니다|니까|십시오)$/u;

function isFormal(sentence: string): boolean {
  let core = sentence.replace(/[.?!]+$/u, "").trim();
  for (let previous = ""; previous !== core; ) {
    previous = core;
    core = core.replace(/\s*\([^()]*\)$/u, "").replace(/["'”’)\]]+$/u, "").trim();
  }
  return FORMAL_ENDING.test(core);
}

function labelOnly(text: string): boolean {
  return !/[\p{L}\p{N}]/u.test(text.replace(PLACEHOLDERS, "").replace(/[\s/,·()+:]/gu, ""));
}

const DASH = /[—―]/u;

/** The description after an allowed "term — definition" dash, or the whole text. */
function definitionOf(text: string): string {
  const match = /^(.+?)\s[—―]\s(.*)$/u.exec(text);
  return match && !DASH.test(match[1]) ? match[2] : text;
}

function itemStyle(item: Item): "sentence" | "noun" | "label" {
  const description = definitionOf(joined(item).text);
  if (sentences(description).some((segment) => segment.terminated || isFormal(segment.text))) return "sentence";
  return labelOnly(description) ? "label" : "noun";
}

// ---------------------------------------------------------------- rules

const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}️/u;

export function lintProse(path: string, source: string, phrases = loadBannedPhrases()): ProseFinding[] {
  const patterns = phrases.map((phrase) => ({ ...phrase, regex: new RegExp(phrase.pattern, "gu") }));
  const masked = mask(source, new Set(phrases.map((phrase) => phrase.id)));
  const findings: ProseFinding[] = [];
  const push = (line: number, rule: ProseRule, detail: string, id?: string) => {
    const message = `${path}:${line} ${detail}`;
    if (!findings.some((finding) => finding.message === message && finding.rule === rule)) {
      findings.push({ path, line, rule, message, ...(id ? { id } : {}) });
    }
  };
  const excerpt = (sentence: string) => {
    const shown = sentence.replace(PLACEHOLDERS, "□");
    return shown.length > 24 ? `…${shown.slice(-24)}` : shown;
  };

  masked.prose.forEach((line, index) => {
    for (const phrase of patterns) {
      phrase.regex.lastIndex = 0;
      if (phrase.regex.test(line)) push(index + 1, "banned-phrase", `[${phrase.id}] ${phrase.message}`, phrase.id);
    }
  });
  for (const line of masked.unclosedBold) {
    push(line, "bold-flanking", "bold will not render: after punctuation, ** needs a space or punctuation next (**…다.** 메시지가, not **…다.**가)");
  }
  masked.visible.forEach((line, index) => {
    if (EMOJI.test(line)) push(index + 1, "emoji", "emoji in prose; manuals use words, not icons");
  });

  const { units, lists } = parse(masked.prose, masked.walls);
  for (const unit of units) {
    const { text, lineAt } = joined(unit);
    // em-dash
    if (unit.kind === "item") {
      const first = text.search(DASH);
      const term = first > 0 ? text.slice(0, first) : "";
      const allowedTerm =
        first > 0 &&
        text[first - 1] === " " &&
        text[first + 1] === " " &&
        lineAt(first) === unit.pieces[0].line &&
        !/[.?!](\s|$)/u.test(term) &&
        !isFormal(term.trim());
      for (let index = 0; index < text.length; index += 1) {
        if (DASH.test(text[index]) && !(index === first && allowedTerm)) {
          push(lineAt(index), "em-dash", 'em dash as a sentence connector; split the sentence (lists may use one "term — definition" dash)');
        }
      }
    } else if (DASH.test(text)) {
      for (let index = 0; index < text.length; index += 1) {
        if (DASH.test(text[index])) push(lineAt(index), "em-dash", "em dash as a sentence connector; split the sentence or use a comma");
      }
    }
    // sentence-ending
    if (unit.kind === "heading") continue;
    for (const segment of sentences(text)) {
      if (!HANGUL.test(segment.text) || isFormal(segment.text)) continue;
      if (unit.kind === "paragraph") {
        push(lineAt(segment.end), "sentence-ending", segment.terminated
          ? `sentence does not end in 합니다체 (~합니다/~입니다): "${excerpt(segment.text)}"`
          : `paragraph ends in a fragment; finish it as a 합니다체 sentence: "${excerpt(segment.text)}"`);
      } else if (segment.terminated) {
        push(lineAt(segment.end), "sentence-ending",
          `sentence does not end in 합니다체; noun-phrase items and cells take no final period: "${excerpt(segment.text)}"`);
      }
    }
  }

  for (const list of lists) {
    const styled = list.items
      .map((item) => ({ item, style: itemStyle(item) }))
      .filter(({ item, style }) => !(style === "label" && item.hasChildren))
      .map(({ item, style }) => ({ item, style: style === "label" ? "noun" : style }));
    const odd = styled.find(({ style }) => style !== styled[0]?.style);
    if (odd) {
      push(odd.item.pieces[0].line, "mixed-list",
        `list mixes ${styled[0].style} items and ${odd.style} items; use one style per list (all ~합니다. sentences or all noun phrases)`);
    }
  }

  const kept = findings.filter((finding) => {
    const directive = masked.directives.find((candidate) =>
      candidate.valid &&
      candidate.target === finding.line &&
      candidate.rules.some((rule) => rule === finding.rule || rule === `${finding.rule}/${finding.id}`));
    if (directive) directive.used = true;
    return !directive;
  });
  for (const directive of masked.directives) {
    if (!directive.valid) {
      kept.push({ path, line: directive.line, rule: "disable-syntax", message: `${path}:${directive.line} prose-lint directive ${directive.problem}` });
    } else if (!directive.used) {
      kept.push({ path, line: directive.line, rule: "unused-disable", message: `${path}:${directive.line} prose-lint directive suppresses nothing; remove it` });
    }
  }
  return kept.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

// ---------------------------------------------------------------- CLI

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return entry.endsWith(".mdx") ? [path] : [];
  });
}

export function lintKoDocs(root = KO_DOCS_ROOT): ProseFinding[] {
  const phrases = loadBannedPhrases();
  return walk(root).sort().flatMap((file) => lintProse(relative(SITE_ROOT, file), readFileSync(file, "utf8"), phrases));
}

if (import.meta.main) {
  const findings = lintKoDocs();
  if (findings.length > 0) {
    console.error("Prose lint failed (rules: skills/butler-docs-writing/SKILL.md):");
    for (const finding of findings) console.error(`  [${finding.rule}] ${finding.message}`);
    process.exit(1);
  }
  console.log(`Prose lint passed (${walk(KO_DOCS_ROOT).length} ko pages).`);
}
