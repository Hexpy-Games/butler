import { useEffect, useRef, useState } from "react";
import { Stack, Typo } from "@/butler-ds";
import { api } from "@/app/api";
import { appCopy } from "@/app/copy";
import type { OperationOutputView } from "@/app/types";

/** Mounted by the tool row's Collapsible only while its body is open. */
export function ThinkingDetails({ text, turnId, requestId, resultId }: {
  text?: string; turnId?: string; requestId?: string; resultId?: string;
}) {
  const retained = useRef(text);
  if (text !== undefined) retained.current = text;
  const [stored, setStored] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (text !== undefined || !turnId || !requestId || !resultId) return;
    let active = true;
    void api<OperationOutputView>(`/turns/${encodeURIComponent(turnId)}/operations/${encodeURIComponent(requestId)}/output?result_id=${encodeURIComponent(resultId)}&offset=0`)
      .then(output => { if (active) setStored(output.content); }, () => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [text, turnId, requestId, resultId]);
  if (failed) return <Typo.Caption>{appCopy.interfaceDetails.outputLoadFailed}</Typo.Caption>;
  return <Stack gap="sm" data-test-class="thinking-details">
    {(text ?? stored ?? retained.current ?? "").split(/\r?\n\s*\r?\n/u).filter(paragraph => paragraph.trim()).map((paragraph, index) => (
      <Typo.Caption key={index} as="p" tone="tertiary" wrap="pre">
        {paragraph.trim().split("\n").map((line, lineIndex) => {
          const heading = /^(?:#{1,6}\s+(.+)|\*\*(.+)\*\*)$/u.exec(line.trim());
          return <Typo.Caption key={lineIndex} as="span" tone={heading ? "secondary" : "tertiary"} weight={heading ? "semibold" : "regular"}>
            {lineIndex > 0 ? "\n" : ""}{heading ? heading[1] ?? heading[2] : line}
          </Typo.Caption>;
        })}
      </Typo.Caption>
    ))}
  </Stack>;
}
