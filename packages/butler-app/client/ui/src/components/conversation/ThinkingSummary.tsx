import { useId, useState } from "react";
import { Button, ChevronDown, ChevronRight, Collapsible, Stack, Typo } from "@/butler-ds";
import { appCopy, useAppLocale } from "@/app/copy";
import { useModelThinking } from "@/app/modelThinking";
import { useButlerStore } from "@/app/store";

/** Retain the last live content only until the DS exit finishes. */
export function ThinkingSummary({ turnId, active }: { turnId?: string; active: boolean }) {
  useAppLocale();
  const enabled = useButlerStore(state => state.settings.show_thinking);
  const summary = useModelThinking(state => turnId ? state.summaries[turnId] : undefined);
  const incoming = enabled && active ? summary : undefined;
  const [shown, setShown] = useState(incoming);
  const [expandedStream, setExpandedStream] = useState<string>();
  const contentId = useId();
  if (incoming && incoming !== shown) setShown(incoming);
  const expanded = expandedStream === shown?.stream && expandedStream !== undefined;
  return (
    <Collapsible open={Boolean(incoming)} appear onExitComplete={() => { setShown(undefined); setExpandedStream(undefined); }}>
      <Stack gap="xs" cross="start" data-test-class="thinking-summary">
        <Button variant="inline" size="sm" aria-expanded={expanded} aria-controls={contentId}
          iconEnd={expanded ? <ChevronDown size="sm" /> : <ChevronRight size="sm" />}
          onClick={() => setExpandedStream(expanded ? undefined : shown?.stream)}>
          {appCopy.interfaceStatus.thinkingSummary}
        </Button>
        <Collapsible open={expanded} id={contentId}>
          <Stack gap="xs" data-test-class="thinking-summary-content">
            {shown?.text.split("\n").map((line, index) => {
              const heading = /^(?:#{1,6}\s+(.+)|\*\*(.+)\*\*)$/u.exec(line.trim());
              return <Typo.Caption key={index} as="div" tone="tertiary" wrap="pre" weight={heading ? "semibold" : "regular"}>
                {heading ? heading[1] ?? heading[2] : line || "\n"}
              </Typo.Caption>;
            })}
          </Stack>
        </Collapsible>
      </Stack>
    </Collapsible>
  );
}
