/** Runtime-owned file change data produced at the guarded mutation boundary. */
export type ChangedFileLine = {
  type: "added" | "deleted";
  old_line?: number;
  new_line?: number;
  content: string;
};

export type ChangedFileDetail = {
  path: string;
  additions: number;
  deletions: number;
  lines: ChangedFileLine[];
  /** Internal aggregation aid; removed before any provider/App projection. */
  before_text?: string;
  /** Internal aggregation aid; removed before any provider/App projection. */
  after_text?: string;
  /** Internal distinction for a newly-created empty file. */
  file_created?: true;
};

type DiffLine = { type: ChangedFileLine["type"]; value: string; oldLine: number; newLine: number };

/** Build a changed-only, line-numbered diff from guarded mutation contents. */
export function changedFileDetail(
  path: string,
  before: Buffer | string,
  after: Buffer | string,
  options: { created?: boolean } = {},
): ChangedFileDetail | null {
  const oldLines = splitLines(toText(before));
  const newLines = splitLines(toText(after));
  const lines = lineDiff(oldLines, newLines).map<ChangedFileLine>((row) =>
    row.type === "added"
      ? { type: "added", new_line: row.newLine, content: row.value }
      : { type: "deleted", old_line: row.oldLine, content: row.value },
  );
  if (lines.length === 0 && !options.created) return null;
  return {
    path,
    additions: lines.filter((line) => line.type === "added").length,
    deletions: lines.filter((line) => line.type === "deleted").length,
    lines,
    before_text: toText(before),
    after_text: toText(after),
    ...(options.created ? { file_created: true as const } : {}),
  };
}

function toText(value: Buffer | string): string {
  return typeof value === "string" ? value : value.toString("utf8");
}

function splitLines(value: string): string[] {
  if (value.length === 0) return [];
  const lines = value.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** A deterministic LCS keeps small mutation diffs readable without a dependency. */
function lineDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  let prefixLength = 0;
  while (prefixLength < oldLines.length && prefixLength < newLines.length &&
      oldLines[prefixLength] === newLines[prefixLength]) {
    prefixLength += 1;
  }
  let suffixLength = 0;
  while (suffixLength < oldLines.length - prefixLength &&
      suffixLength < newLines.length - prefixLength &&
      oldLines[oldLines.length - suffixLength - 1] ===
        newLines[newLines.length - suffixLength - 1]) {
    suffixLength += 1;
  }
  const oldLength = oldLines.length - prefixLength - suffixLength;
  const newLength = newLines.length - prefixLength - suffixLength;
  const table = Array.from({ length: oldLength + 1 }, () =>
    new Uint32Array(newLength + 1));
  for (let oldIndex = oldLength - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLength - 1; newIndex >= 0; newIndex -= 1) {
      table[oldIndex]![newIndex] = oldLines[prefixLength + oldIndex] ===
        newLines[prefixLength + newIndex]
        ? table[oldIndex + 1]![newIndex + 1]! + 1
        : Math.max(table[oldIndex + 1]![newIndex]!, table[oldIndex]![newIndex + 1]!);
    }
  }
  const rows: DiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLength || newIndex < newLength) {
    if (oldIndex < oldLength && newIndex < newLength &&
        oldLines[prefixLength + oldIndex] === newLines[prefixLength + newIndex]) {
      oldIndex += 1;
      newIndex += 1;
      continue;
    }
    if (oldIndex < oldLength && (newIndex >= newLength ||
        table[oldIndex + 1]![newIndex]! >= table[oldIndex]![newIndex + 1]!)) {
      rows.push({
        type: "deleted",
        value: oldLines[prefixLength + oldIndex]!,
        oldLine: prefixLength + oldIndex + 1,
        newLine: prefixLength + newIndex,
      });
      oldIndex += 1;
    } else {
      rows.push({
        type: "added",
        value: newLines[prefixLength + newIndex]!,
        oldLine: prefixLength + oldIndex,
        newLine: prefixLength + newIndex + 1,
      });
      newIndex += 1;
    }
  }
  return rows;
}

/** Combine repeated mutations into one public net diff per path. */
export function aggregateChangedFileDetails(
  details: readonly ChangedFileDetail[],
): ChangedFileDetail[] {
  const byPath = new Map<string, ChangedFileDetail[]>();
  for (const detail of details) {
    if (detail.path) {
      byPath.set(detail.path, [...(byPath.get(detail.path) ?? []), detail]);
    }
  }
  return [...byPath.entries()].flatMap(([path, entries]) => {
    const first = entries[0]!;
    const last = entries.at(-1)!;
    const net = first.before_text !== undefined && last.after_text !== undefined
      ? changedFileDetail(path, first.before_text, last.after_text, {
          created: first.file_created,
        })
      : last;
    return net ? [publicChangedFileDetail(net)] : [];
  });
}

function publicChangedFileDetail(detail: ChangedFileDetail): ChangedFileDetail {
  return {
    path: detail.path,
    additions: detail.additions,
    deletions: detail.deletions,
    lines: detail.lines,
  };
}
