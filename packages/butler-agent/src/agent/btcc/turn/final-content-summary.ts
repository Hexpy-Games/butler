/** Projects a bounded public summary from the already-public canonical BTCC final content. */
export function projectBtccFinalContentSummary(content: string): string {
  const structured = reportField(content, "conclusion") ?? structuredJsonSummary(content);
  return structured ?? firstPublicSummary(content);
}

export function projectBtccFinalReport(
  content: string,
  knownArtifacts: readonly string[] = [],
): { summary: string; changedArtifacts: string[] } {
  return {
    summary: projectBtccFinalContentSummary(content),
    changedArtifacts: [...new Set([
      ...knownArtifacts,
      ...structuredChangedArtifacts(content),
    ].map(safeArtifactLabel).filter((value): value is string => Boolean(value)))]
      .slice(0, 12),
  };
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

function structuredChangedArtifacts(content: string): string[] {
  try {
    const report = JSON.parse(content) as unknown;
    if (!isPlainObject(report) || !Array.isArray(report.changed_artifacts)) return [];
    return report.changed_artifacts.filter(
      (value): value is string => typeof value === "string",
    );
  } catch {
    return [];
  }
}

function safeArtifactLabel(value: string): string | null {
  const label = value.replace(/\\/gu, "/").replace(/\s+/gu, " ").trim();
  if (!label || label.length > 500 || label.startsWith("/") || label.startsWith("~")) {
    return null;
  }
  if (label.split("/").some((segment) => segment === "..")) return null;
  return label;
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
