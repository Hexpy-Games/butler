/** Projects a bounded public summary from the already-public canonical BTCC final content. */
export function projectBtccFinalContentSummary(content: string): string {
  const structured = reportField(content, "conclusion") ?? structuredJsonSummary(content);
  return structured ?? firstPublicSummary(content);
}

function reportField(content: string, label: string): string | undefined {
  return content.match(new RegExp(`^(?:[-*]\\s*)?${label}\\s*:\\s*(.+)$`, "imu"))?.[1]
    ?.replace(/\s+/gu, " ").trim();
}

function structuredJsonSummary(content: string): string | undefined {
  try {
    const report = JSON.parse(content) as unknown;
    if (!isPlainObject(report)) return undefined;
    const summary = report.summary;
    const candidate = isPlainObject(summary)
      ? summary.conclusion ?? summary.title ?? summary.document
      : summary ?? report.conclusion;
    return typeof candidate === "string"
      ? candidate.replace(/\s+/gu, " ").trim() || undefined
      : undefined;
  } catch {
    return undefined;
  }
}

function firstPublicSummary(content: string): string {
  const line = content.split(/\r?\n/gu)
    .map((value) => value.replace(/^\s*(?:#{1,6}|[-*])\s*/u, "")
      .replace(/[*_`]/gu, "").replace(/\s+/gu, " ").trim())
    .find((value) => value.length > 0 &&
      !["{", "}", "[", "]", ","].includes(value) &&
      !/^(?:"[^"]+"\s*:|conclusion|evidence|tests?|remaining risks?)\s*:?/iu.test(value));
  return line ?? content.replace(/\s+/gu, " ").trim();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
