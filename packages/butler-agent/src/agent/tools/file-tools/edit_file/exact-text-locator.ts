export type ExactTextLocation = {
  offset: number;
  startLine: number;
};

type ExactTextLocationResult =
  | { ok: true; value: ExactTextLocation }
  | {
      ok: false;
      error: "old_text_mismatch" | "old_text_ambiguous";
      occurrenceCount: number;
    };

export function locateExactText(input: {
  text: string;
  oldText: string;
  startLine?: number;
}): ExactTextLocationResult {
  if (!input.oldText) {
    return { ok: false, error: "old_text_mismatch", occurrenceCount: 0 };
  }

  let occurrenceCount = 0;
  let first: ExactTextLocation | undefined;
  let hinted: ExactTextLocation | undefined;
  let hintedCount = 0;
  let searchFrom = 0;
  let scannedTo = 0;
  let startLine = 1;
  while (searchFrom <= input.text.length - input.oldText.length) {
    const offset = input.text.indexOf(input.oldText, searchFrom);
    if (offset < 0) break;
    while (scannedTo < offset) {
      if (input.text[scannedTo] === "\n") startLine += 1;
      scannedTo += 1;
    }
    const location = { offset, startLine };
    if (!first) first = location;
    occurrenceCount = Math.min(2, occurrenceCount + 1);
    if (input.startLine === undefined && occurrenceCount === 2) {
      return {
        ok: false,
        error: "old_text_ambiguous",
        occurrenceCount,
      };
    }
    if (input.startLine !== undefined && startLine === input.startLine) {
      hintedCount = Math.min(2, hintedCount + 1);
      if (!hinted) hinted = location;
    }
    searchFrom = offset + 1;
  }

  if (!first) {
    return { ok: false, error: "old_text_mismatch", occurrenceCount: 0 };
  }
  if (occurrenceCount === 1) return { ok: true, value: first };
  if (input.startLine !== undefined && hintedCount === 1 && hinted) {
    return { ok: true, value: hinted };
  }
  return {
    ok: false,
    error: "old_text_ambiguous",
    occurrenceCount,
  };
}
