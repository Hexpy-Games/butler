import { useEffect, useRef, useState } from "react";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import type { AuthorityDecisionResult, SessionView } from "../../../butler-protocol/src/index.ts";
import { Button, ButtonGroup, CodeBlock, DecisionCard, Text, TextField, showToast } from "@/ds";
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

type InputKind = "username" | "password" | "otp";
interface HandoffInput {
  origin: string;
  fields: InputKind[];
  live: boolean;
  save_offer: { username: string; host: string } | null;
}

export function BrowserHandoffCard({ card, view, reload }: {
  card: AuthorityApprovalCard; view: SessionView; reload(): void;
}) {
  const copy = getAppCopy(useAppLocale()), browser = copy.browser;
  const { client, secureClient } = useConversation();
  const [pending, setPending] = useState<"stop" | "done" | "sent" | "input" | "save">();
  const [failed, setFailed] = useState(false);
  const [fillFailed, setFillFailed] = useState(false);
  const [input, setInput] = useState<HandoffInput>();
  const [values, setValues] = useState<Partial<Record<InputKind, string>>>({});
  const inFlight = useRef(false);
  const sessionId = view.session_id, turn = view.active_turn;
  const child = view.steward_children?.find(c => c.session_id === card.sourceSessionId);
  const handoff = browserHandoffView(card, copy.interfaceTemplates.approvalRequest);
  const base = `/authority-requests/${encodeURIComponent(card.requestRef)}`, query = `?session_id=${encodeURIComponent(sessionId)}`;
  useEffect(() => {
    let mounted = true;
    void secureClient?.request<HandoffInput>(base + "/input" + query)
      .then(result => { if (mounted) setInput(result); }).catch(() => {});
    return () => { mounted = false; };
  }, [base, query, secureClient]);
  const send = async (kind: "stop" | "done", path: string, body: Record<string, string>) => {
    if (!client || inFlight.current) return;
    inFlight.current = true; setPending(kind); setFailed(false);
    try { await client.request(path, { body }); setPending("sent"); reload(); }
    catch { setFailed(true); inFlight.current = false; setPending(undefined); }
  };
  if (!handoff) return null;
  const labels = copy.interfaceTemplates.approvalRequest.signInHandoff;
  const currentInput = secureClient ? input : undefined;
  const fields = currentInput?.fields ?? [], offer = currentInput?.save_offer;
  const canFill = fields.some(kind => values[kind]);
  const act = async (save?: boolean) => {
    if (!secureClient || pending || inFlight.current || (save === undefined && (!input || !canFill))) return;
    inFlight.current = true; setPending(save === undefined ? "input" : "save"); setFillFailed(false);
    try {
      if (save === undefined && input) {
        const result = await secureClient.request<{ status: string; handed_back: boolean }>(base + "/input" + query, { body: { origin: input.origin, values } }).finally(() => setValues({}));
        setFillFailed(result.status !== "filled");
        if (result.handed_back) reload();
      } else if (save !== undefined) {
        const result = await secureClient.request<{ saved: boolean; handed_back: boolean }>(base + "/input-save" + query, { body: { save } });
        if (save) showToast({ message: result.saved ? browser.signinSaved : browser.signinSaveFailed, tone: result.saved ? "success" : "error" });
        if (result.handed_back) reload();
      }
    } catch {
      if (save === undefined) setFillFailed(true);
      else if (save) showToast({ message: browser.signinSaveFailed, tone: "error" });
    } finally {
      setInput(await secureClient.request<HandoffInput>(base + "/input" + query).catch(() => undefined));
      setPending(undefined); inFlight.current = false;
    }
  };
  const host = currentInput?.origin ? new URL(currentInput.origin).host : undefined;
  return <DecisionCard eyebrow={labels.eyebrow} title={handoff.title}
    footnote={fillFailed ? browser.signinFillFailed : failed ? copy.interfaceDetails.decisionFailed : undefined}
    actions={<ButtonGroup layout="pair">
      <Button label={labels.stop} variant="secondary" loading={pending === "stop"} disabled={!!pending || (!child && !turn)}
        onPress={() => {
          if (child) void send("stop", `/steward-relations/${encodeURIComponent(child.relation.relation_id)}/cancel`, { parent_session_id: sessionId });
          else if (turn) void send("stop", `/turns/${encodeURIComponent(turn.id)}/cancel`, {});
        }} />
      <Button label={labels.done} variant={fields.length ? "secondary" : "default"} loading={pending === "done"} disabled={!!pending}
        onPress={() => void send("done", base + "/hand-back" + query, {})} />
    </ButtonGroup>}>
    {host ? <Text literal>{host}</Text> : null}
    {handoff.details.slice(0, fields.length || currentInput?.live ? -1 : undefined).map((line, index) => <Text key={index} literal>{line}</Text>)}
    {fields.map(kind => <TextField key={kind} label={labels.fields[kind]} value={values[kind] ?? ""}
      secureTextEntry={kind === "password"} autoComplete={kind === "otp" ? "one-time-code" : kind}
      keyboardType={kind === "otp" ? "number-pad" : undefined} returnKeyType="done" disabled={!!pending}
      onChangeText={value => setValues({ ...values, [kind]: value })} onSubmitEditing={() => void act()} />)}
    {fields.length > 0 ? <ButtonGroup><Button label={labels.submit} disabled={!canFill || !!pending}
      loading={pending === "input"} onPress={() => void act()} /></ButtonGroup> : null}
    {offer ? <>
      <Text literal>{browser.saveSignIn} · {offer.username} · {offer.host}</Text>
      <ButtonGroup layout="pair">
        <Button label={browser.later} variant="secondary" disabled={!!pending} onPress={() => void act(false)} />
        <Button label={browser.saveSignIn} disabled={!!pending} loading={pending === "save"} onPress={() => void act(true)} />
      </ButtonGroup>
    </> : null}
  </DecisionCard>;
}
