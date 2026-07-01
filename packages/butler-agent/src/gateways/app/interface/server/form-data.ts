export function isUploadFile(value: FormDataEntryValue | null): value is File {
  return Boolean(
    value &&
      typeof value === "object" &&
      "arrayBuffer" in value &&
      typeof value.arrayBuffer === "function" &&
      "name" in value &&
      typeof value.name === "string",
  );
}

export function safeOptionalString(
  value: FormDataEntryValue | null,
): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function contentDispositionForAttachment(name: string): string {
  const fallback = asciiAttachmentFilenameFallback(name);
  return `inline; filename="${fallback}"; filename*=UTF-8''${encodeRFC5987ValueChars(name)}`;
}

function asciiAttachmentFilenameFallback(value: string): string {
  const fallback = Array.from(value || "attachment", (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || codePoint > 0x7e) return "_";
    if (character === "\"" || character === "\\") return "_";
    return character;
  })
    .join("")
    .replace(/_+/gu, "_")
    .replace(/[\r\n]+/gu, "_")
    .trim()
    .slice(0, 160);
  return fallback && /[A-Za-z0-9]/u.test(fallback) ? fallback : "attachment";
}

function encodeRFC5987ValueChars(value: string): string {
  return encodeURIComponent(value)
    .replace(
      /['()]/gu,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    )
    .replace(/\*/gu, "%2A");
}
