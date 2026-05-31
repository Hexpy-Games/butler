import telegramify from "telegramify-markdown";

export const TELEGRAM_MARKDOWN_V2_PARSE_MODE = "MarkdownV2";

export type TelegramOutboundFormat = "markdownv2" | "text";

export function normalizeTelegramOutboundFormat(value: unknown): TelegramOutboundFormat {
  if (typeof value !== "string") return "markdownv2";
  return value.trim().toLowerCase() === "text" ? "text" : "markdownv2";
}

export function toTelegramMarkdownV2(text: string): string {
  return escapeSourceTitleTildes(
    repairDoubleEscapedReservedCharacters(telegramify(text, "escape")),
  ).trimEnd();
}

const TELEGRAM_RESERVED_CHARACTERS = new Set("_*[]()~`>#+-=|{}.!\\");

function repairDoubleEscapedReservedCharacters(text: string): string {
  // telegramify can double-escape reserved symbols in table cells. Telegram
  // then treats the first slash as a literal backslash and rejects the symbol.
  return text.replace(/\\\\(.)/g, (match, character: string) =>
    TELEGRAM_RESERVED_CHARACTERS.has(character) ? `\\${character}` : match);
}

function escapeSourceTitleTildes(text: string): string {
  // Source titles often contain single tildes. Telegram MarkdownV2 treats those
  // as strikethrough, which is almost never intended for Butler reports.
  let rendered = "";
  let inlineCode = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    const escaped = isEscapedAt(text, index);
    if (character === "`" && !escaped) {
      inlineCode = !inlineCode;
      rendered += character;
      continue;
    }
    if (character === "~" && !escaped && !inlineCode) {
      rendered += "\\~";
      continue;
    }
    rendered += character;
  }
  return rendered;
}

function isEscapedAt(text: string, index: number): boolean {
  if (index <= 0) return false;
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}
