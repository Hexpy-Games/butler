import { useRef, useState } from "react";
import { useRouter } from "expo-router";
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
  const decide = async (action: "allow" | "deny", scope: "once" | "conversation" | "site" | "always" = "once") => {
    if (!client || inFlight.current) return;
    inFlight.current = true; setPending(action === "deny" ? "deny" : scope); setFailed(false);
    try {
      const result = await client.request<AuthorityDecisionResult>(
        `/authority-requests/${encodeURIComponent(card.requestRef)}/${action}?session_id=${encodeURIComponent(sessionId)}`,
        { body: action === "allow" ? { scope } : {} });
      if (result.request_ref !== card.requestRef || result.decision !== (action === "allow" ? "allowed" : "denied")
        || typeof result.scheduled !== "boolean") throw new Error("Decision not accepted");
      setPending("done");
      reload();
    } catch { setFailed(true); inFlight.current = false; setPending(undefined); }
  };
  const allow = <Button label={site ? labels.allowInChat : labels.allowOnce} onPress={() => void decide("allow")}
    disabled={!!pending} loading={pending === "once"} />;
  const deny = <Button label={labels.deny} variant="secondary" onPress={() => void decide("deny")}
    disabled={!!pending} loading={pending === "deny"} />;
  return <DecisionCard eyebrow={<>{copy.composer.permission}{count > 1 ? <Text variant="caption">{` +${count - 1}`}</Text> : null}</>}
    tag={{ label: copy.interfaceTemplates.approvalRequest.risk[view.risk], tone: { low: "neutral", medium: "warning", high: "danger" }[view.risk] as "neutral" | "warning" | "danger" }}
    title={view.title} footnote={failed ? labels.decisionFailed : undefined}
    actions={scope || view.ruleText ? <ButtonGroup>{allow}
      {scope ? <Button label={site ? site === "payment" ? labels.allowPaymentSite : labels.allowSite : labels.allowConversation}
        variant="secondary" onPress={() => void decide("allow", scope)} disabled={!!pending} loading={pending === scope} /> : null}
      {view.ruleText ? <Button label={labels.allowAlways} variant="secondary"
        onPress={() => void decide("allow", "always")} disabled={!!pending} loading={pending === "always"} /> : null}
      {deny}
    </ButtonGroup> : <ButtonGroup layout="pair">{deny}{allow}</ButtonGroup>}>
    {view.ruleText ? <Text variant="caption" tone="secondary" literal>{view.ruleText}</Text> : null}
    {view.details.map((line, index) => typeof line === "string"
      ? <Text key={index} variant={view.pathDetails?.includes(line) ? "caption" : "body"}
        tone={view.pathDetails?.includes(line) ? "secondary" : "primary"} literal>{line}</Text>
      : <CodeBlock key={index} code={line.code} inset />)}
  </DecisionCard>;
}

export function BrowserHandoffCard({ card, view, reload }: {
  card: AuthorityApprovalCard; view: SessionView; reload(): void;
}) {
  const router = useRouter();
  const copy = getAppCopy(useAppLocale());
  const { client } = useConversation();
  const [pending, setPending] = useState<"stop" | "done" | "sent">();
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);
  const sessionId = view.session_id;
  const turn = view.active_turn;
  const child = view.steward_children?.find(c => c.session_id === card.sourceSessionId);
  const handoff = browserHandoffView(card, copy.interfaceTemplates.approvalRequest);
  const send = async (kind: "stop" | "done", path: string, body: Record<string, string>) => {
    if (!client || inFlight.current) return;
    inFlight.current = true; setPending(kind); setFailed(false);
    try { await client.request(path, { body }); setPending("sent"); reload(); }
    catch { setFailed(true); inFlight.current = false; setPending(undefined); }
  };
  if (!handoff) return null;
  const labels = copy.interfaceTemplates.approvalRequest.signInHandoff;
  const tabId = card.approval?.operation?.browser_tab;
  return <DecisionCard eyebrow={labels.eyebrow} title={handoff.title}
    footnote={failed ? copy.interfaceDetails.decisionFailed : undefined}
    actions={<ButtonGroup layout="pair">
      <Button label={labels.stop} variant="secondary" loading={pending === "stop"} disabled={!!pending || (!child && !turn)}
        onPress={() => {
          if (child) void send("stop", `/steward-relations/${encodeURIComponent(child.relation.relation_id)}/cancel`, { parent_session_id: sessionId });
          else if (turn) void send("stop", `/turns/${encodeURIComponent(turn.id)}/cancel`, {});
        }} />
      <Button label={labels.done} loading={pending === "done"} disabled={!!pending}
        onPress={() => void send("done", `/authority-requests/${encodeURIComponent(card.requestRef)}/hand-back?session_id=${encodeURIComponent(sessionId)}`, {})} />
    </ButtonGroup>}>
    {handoff.details.map((line, index) => <Text key={index} literal>{line}</Text>)}
    {typeof tabId === "string" && tabId.length > 0 ? <ButtonGroup>
      <Button variant="secondary" label={labels.openScreen}
        onPress={() => router.push({ pathname: "/browser-live/[tabId]", params: { tabId, session: sessionId, request: card.requestRef } })} />
    </ButtonGroup> : null}
  </DecisionCard>;
}
