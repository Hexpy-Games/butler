import type { CSSProperties } from "react";
import { ScrollArea, Stack, Typo } from "@/butler-ds";

const PRE_STYLE: CSSProperties = {
  margin: 0,
  padding: "var(--space-md)",
  color: "var(--text-primary)",
  font: "var(--typo-code-font)",
  letterSpacing: "var(--typo-code-letter-spacing)",
  whiteSpace: "pre-wrap",
  overflowWrap: "anywhere",
};

export function RawBlock({
  title,
  value,
  compact = false,
  hideTitle = false,
}: {
  title: string;
  value: string;
  compact?: boolean;
  hideTitle?: boolean;
}) {
  return (
    <Stack gap="xs">
      {hideTitle ? null : <Typo.Caption>{title}</Typo.Caption>}
      <ScrollArea style={{ maxHeight: compact ? 180 : 320 }}>
        <pre style={PRE_STYLE}>{value || "-"}</pre>
      </ScrollArea>
    </Stack>
  );
}
