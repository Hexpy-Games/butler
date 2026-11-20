import { useRef, useState } from "react";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import type { AuthorityDecisionResult, SessionView } from "../../../butler-protocol/src/index.ts";
import { Button, ButtonGroup, CodeBlock, DecisionCard, Text } from "@/ds";
import { useAppLocale } from "@/i18n";
import { useConversation } from "./live";
import { approvalRequestView, browserHandoffView, type AuthorityApprovalCard } from "./approval";

export function ApprovalCard({ card, count, sessionId, reload }: {
  card: AuthorityApprovalCard; count: number; sessionId: string; reload(): void;
}) {
  const locale = useAppLocale(), copy = getAppCopy(locale), labels = copy.interfaceDetails;
  const { client } = useConversation();
  const [pending, setPending] = useState<string>();
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);
  const view = approvalRequestView(card, copy, copy.guided.tools, locale);
  const site = card.approval?.operation?.allow_site;
  const scope = site ? "site" : card.scope && card.approval?.operation?.allow_conversation !== false ? "conversation" : undefined;
  const decide = async (action: "allow" | "deny", scope: "once" | "conversation" | "site" = "once") => {
    if (!client || inFlight.current) return;
    inFlight.current = true; setPending(action === "deny" ? "deny" : scope); setFailed(false);
    try {
      const result = await client.request<AuthorityDecisionResult>(
        `/authority-requests/${encodeURIComponent(card.requestRef)}/${action}?session_id=${encodeURIComponent(sessionId)}`,
        { body: action === "allow" ? { scope } : {} });
      if (result.request_ref !== card.requestRef || result.decision !== (action === "allow" ? "allowed" : "denied")
        || typeof result.scheduled !== "boolean") throw new Error("Decision not accepted");
      reload();
    } catch { setFailed(true); }
    finally { inFlight.current = false; setPending(undefined); }
  };
  const allow = <Button label={site ? labels.allowInChat : labels.allowOnce} onPress={() => void decide("allow")}
    disabled={!!pending} loading={pending === "once"} />;
  const deny = <Button label={labels.deny} variant="secondary" onPress={() => void decide("deny")}
    disabled={!!pending} loading={pending === "deny"} />;
  return <DecisionCard eyebrow={<>{copy.composer.permission}{count > 1 ? <Text variant="caption">{` +${count - 1}`}</Text> : null}</>}
    tag={{ label: copy.interfaceTemplates.approvalRequest.risk[view.risk], tone: { low: "neutral", medium: "warning", high: "danger" }[view.risk] as "neutral" | "warning" | "danger" }}
    title={view.title} footnote={failed ? labels.decisionFailed : undefined}
    actions={scope ? <ButtonGroup>{allow}
      <Button label={site ? site === "payment" ? labels.allowPaymentSite : labels.allowSite : labels.allowConversation}
        variant="secondary" onPress={() => void decide("allow", scope)} disabled={!!pending} loading={pending === scope} />
      {deny}
    </ButtonGroup> : <ButtonGroup layout="pair">{deny}{allow}</ButtonGroup>}>
    {view.details.map((line, index) => typeof line === "string"
      ? <Text key={index} variant={view.pathDetails?.includes(line) ? "caption" : "body"}
        tone={view.pathDetails?.includes(line) ? "secondary" : "primary"} literal>{line}</Text>
      : <CodeBlock key={index} code={line.code} inset />)}
  </DecisionCard>;
}

export function BrowserHandoffCard({ card, turn, reload }: {
  card: AuthorityApprovalCard; turn: SessionView["active_turn"]; reload(): void;
}) {
  const copy = getAppCopy(useAppLocale());
  const { client } = useConversation();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);
  const view = browserHandoffView(card, copy.interfaceTemplates.approvalRequest);
  const stop = async () => {
    if (!client || !turn || inFlight.current) return;
    inFlight.current = true; setPending(true); setFailed(false);
    try { await client.request(`/turns/${encodeURIComponent(turn.id)}/cancel`, { body: {} }); reload(); }
    catch { setFailed(true); }
    finally { inFlight.current = false; setPending(false); }
  };
  if (!view) return null;
  return <DecisionCard eyebrow={copy.interfaceTemplates.approvalRequest.signInHandoff.eyebrow} title={view.title}
    footnote={failed ? copy.interfaceDetails.decisionFailed : undefined}
    actions={<ButtonGroup><Button label={copy.interfaceTemplates.approvalRequest.signInHandoff.stop} variant="secondary"
      onPress={() => void stop()} loading={pending} disabled={pending || !turn} /></ButtonGroup>}>
    {view.details.map((line, index) => <Text key={index} literal>{line}</Text>)}
  </DecisionCard>;
}
