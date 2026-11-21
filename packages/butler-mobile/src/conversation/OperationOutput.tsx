import { useEffect, useRef, useState } from "react";
import { ScrollView, View } from "react-native";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import type { OperationOutputView } from "../../../butler-protocol/src/index.ts";
import { RADIUS } from "@/design/tokens";
import { useTokens } from "@/design/useTokens";
import { Button } from "@/ds/Button";
import { Text } from "@/ds/Text";
import { BaseText } from "@/ds/internal/BaseText";
import { CODE_FONT } from "@/ds/internal/codeFont";
import { useAppLocale } from "@/i18n";
import { useConversation } from "./live";
import { readOutputPage, presentOperationOutput, type OperationOutputPresentation } from "./operationOutput.ts";

export function OperationOutput({ turnId, requestId, resultId, toolName, command }: {
  turnId: string; requestId: string; resultId: string; toolName?: string; command?: string;
}) {
  const copy = getAppCopy(useAppLocale());
  const t = useTokens();
  const { client } = useConversation();
  const [pages, setPages] = useState<OperationOutputView[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const latest = pages.at(-1);
  useEffect(() => {
    if (!client) return;
    let active = true;
    void readOutputPage(client, turnId, requestId, resultId, 0).then(
      page => {
        if (!active) return;
        setPages([page]);
        setState("ready");
      },
      () => { if (active) setState("failed"); },
    );
    return () => { active = false; };
  }, [client, turnId, requestId, resultId]);

  async function loadMore(): Promise<void> {
    if (!client || !latest || latest.complete || state === "loading") return;
    setState("loading");
    try {
      const page = await readOutputPage(client, turnId, requestId, resultId, latest.byte_end);
      setPages(current => [...current, page]);
      setState("ready");
    } catch {
      setState("failed");
    }
  }

  if (state === "failed" && pages.length === 0) {
    return <Text variant="caption">{copy.interfaceDetails.outputLoadFailed}</Text>;
  }
  const output = presentOperationOutput(toolName, pages.map(page => page.content).join(""), latest?.complete === true, copy);
  const execution = output.kind === "command" ? output.command ?? command : command;
  return <View style={{ gap: t.length("--space-xs") }}>
    {execution ? <Text variant="caption">{copy.interfaceStatus.execution}: {execution}</Text> : null}
    {execution ? <Text variant="caption">{copy.interfaceStatus.result}:</Text> : null}
    <OutputBody output={output} />
    {latest && !latest.complete ? <Button variant="ghost" size="sm" disabled={state === "loading"}
      label={state === "loading" ? copy.interfaceDetails.loading : copy.interfaceDetails.moreOutput}
      onPress={() => void loadMore()} /> : null}
  </View>;
}

function OutputBody({ output }: { output: OperationOutputPresentation }) {
  const t = useTokens();
  if (output.kind === "summary") return <Text variant="caption">{output.content}</Text>;
  if (output.kind === "sections") return <View style={{ gap: t.length("--space-xs") }}>
    <Text variant="caption">{output.summary}</Text>
    {output.sections.map((section, index) => <View key={index} style={{ gap: t.length("--space-xs") }}>
      <Text variant="caption">{section.title}</Text>
      {section.message ? <Text variant="caption">{section.message}</Text> : null}
      {section.content ? <WorkActivityOutput>{section.content}</WorkActivityOutput> : null}
    </View>)}
  </View>;
  if (output.kind === "command") return <View style={{ gap: t.length("--space-xs") }}>
    <Text variant="caption">{output.summary}</Text>
    {output.content ? <WorkActivityOutput>{output.content}</WorkActivityOutput> : null}
  </View>;
  return <WorkActivityOutput>{output.content}</WorkActivityOutput>;
}

function WorkActivityOutput({ children }: { children: string }) {
  const t = useTokens();
  return <ScrollView style={{ maxHeight: 320, borderWidth: t.length("--border-hairline"),
    borderColor: t.color("--line"), borderRadius: t.length(RADIUS), backgroundColor: t.color("--surface-raised") }}
    contentContainerStyle={{ padding: t.length("--space-2") }}>
    <BaseText style={{ fontFamily: CODE_FONT, fontSize: t.length("--typo-code-size"),
      lineHeight: t.length("--typo-code-line-height"), color: t.color("--text-secondary") }}>{children}</BaseText>
  </ScrollView>;
}

/** Mounted by the tool row only while its body is open. */
export function ThinkingDetails({ text, turnId, requestId, resultId }: {
  text?: string; turnId?: string; requestId?: string; resultId?: string;
}) {
  const copy = getAppCopy(useAppLocale());
  const t = useTokens();
  const { client } = useConversation();
  const retained = useRef(text);
  if (text !== undefined) retained.current = text;
  const [stored, setStored] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!client || text !== undefined || !turnId || !requestId || !resultId) return;
    let active = true;
    void client.request<OperationOutputView>(`/turns/${encodeURIComponent(turnId)}/operations/${encodeURIComponent(requestId)}/output?result_id=${encodeURIComponent(resultId)}&offset=0`)
      .then(output => { if (active) setStored(output.content); }, () => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [client, text, turnId, requestId, resultId]);
  if (failed) return <Text variant="caption">{copy.interfaceDetails.outputLoadFailed}</Text>;
  return <View style={{ gap: t.length("--space-sm") }}>
    {(text ?? stored ?? retained.current ?? "").split(/\r?\n\s*\r?\n/u).filter(paragraph => paragraph.trim()).map((paragraph, index) => (
      <Text variant="caption" key={index} tone="tertiary">
        {paragraph.trim().split("\n").map((line, lineIndex) => {
          const heading = /^(?:#{1,6}\s+(.+)|\*\*(.+)\*\*)$/u.exec(line.trim());
          return <Text variant="caption" key={lineIndex} tone={heading ? "secondary" : "tertiary"} weight={heading ? "semibold" : "regular"}>
            {lineIndex > 0 ? "\n" : ""}{heading ? heading[1] ?? heading[2] : line}
          </Text>;
        })}
      </Text>
    ))}
  </View>;
}
