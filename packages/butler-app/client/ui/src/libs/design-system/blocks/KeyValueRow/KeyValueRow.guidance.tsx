import { useState } from "react";
import type { ShowcaseGuidance } from "../../showcase";
import { Stack } from "../../components/Stack";
import { Typo } from "../../components/Typo";
import { KeyValueRow } from "./KeyValueRow";

// #region recipe: Context legend row
function ContextCategory() {
  return (
    <KeyValueRow label="Conversation" description="Messages and tool results" value="38.1K" meta="54%"
      detailAlign="start" swatchColor="var(--context-chart-2)" valueTextSize="caption" />
  );
}
// #endregion

// #region recipe: Linked chart legend
function LinkedLegend() {
  const [highlighted, setHighlighted] = useState<string | null>(null);
  return (
    <Stack gap="xs">
      <Typo.Caption tone="tertiary">{highlighted ?? "Hover or focus a row"}</Typo.Caption>
      <KeyValueRow label="Conversation" value="5.2K · 54%" valueTextSize="caption" swatchColor="var(--context-chart-5)"
        onHighlightChange={(on) => setHighlighted(on ? "Conversation" : null)} />
      <KeyValueRow label="Subtask" value="4.5K · 46%" valueTextSize="caption" swatchColor="var(--context-chart-5)" swatchPattern="hatched"
        onHighlightChange={(on) => setHighlighted(on ? "Subtask" : null)} />
    </Stack>
  );
}
// #endregion

export const guidance: ShowcaseGuidance = {
  purpose: "A label/value fact row with optional description, meta and a swatch bound to the label line.",
  whenToUse: ["Facts in the inspector, developer logs and document readers", "A chart legend row with a value"],
  whenNotToUse: [
    { when: "Two to five facts on one line", use: "MetaList" },
    { when: "A row with a title and trailing meta that is not a fact", use: "ListRow" },
  ],
  recipes: [
    { name: "Context legend row", description: "swatchColor ties the row to its chart series; the swatch aligns with the label.", render: () => <ContextCategory /> },
    { name: "Linked chart legend", description: "swatchPattern hatched marks the subtask part; onHighlightChange reports hover and focus to the chart.", render: () => <LinkedLegend /> },
  ],
  doDont: [
    {
      do: { caption: "Label left, value right, meta after.", render: () => <ContextCategory /> },
      dont: { caption: "A sentence hides the value you scan for.", render: () => <Stack><Typo.Body>The conversation uses 38.1K tokens (54%).</Typo.Body></Stack> },
    },
  ],
  content: ["Labels are nouns; values are formatted (38.1K, Ready, -)."],
  accessibility: [
    "Label and value read together; the swatch is decorative.",
    "A linked row (onHighlightChange) is one tab stop with the shared focus ring; focus and hover give the same emphasis.",
  ],
  tokens: ["--context-chart-1", "--context-chart-2", "--context-chart-5", "--hatch-alpha", "--text-secondary", "--space-xs", "--focus-ring-room"],
};
