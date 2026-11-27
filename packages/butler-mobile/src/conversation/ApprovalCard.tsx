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

export type InputKind = "username" | "password" | "otp";
type HandoffPending = "stop" | "done" | "sent" | "input" | "save";
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
  const [pending, setPending] = useState<HandoffPending>();
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
  const host = currentInput?.origin && URL.canParse(currentInput.origin) ? new URL(currentInput.origin).host : undefined;
  return <DecisionCard eyebrow={labels.eyebrow} title={handoff.title}
    footnote={fillFailed ? browser.signinFillFailed : failed ? copy.interfaceDetails.decisionFailed : undefined}
    actions={offer && !fields.length ? <SaveButtons labels={{ saveSignIn: browser.saveSignIn, later: browser.later }} pending={pending} onSave={save => void act(save)} /> : <ButtonGroup layout="pair">
      <Button label={labels.stop} variant="secondary" loading={pending === "stop"} disabled={!!pending || (!child && !turn)}
        onPress={() => {
          if (child) void send("stop", `/steward-relations/${encodeURIComponent(child.relation.relation_id)}/cancel`, { parent_session_id: sessionId });
          else if (turn) void send("stop", `/turns/${encodeURIComponent(turn.id)}/cancel`, {});
        }} />
      <Button label={labels.done} variant={fields.length ? "secondary" : "default"} loading={pending === "done"} disabled={!!pending}
        onPress={() => void send("done", base + "/hand-back" + query, {})} />
    </ButtonGroup>}>
    <BrowserHandoffForm labels={{ fields: labels.fields, submit: labels.submit, saveSignIn: browser.saveSignIn, later: browser.later }}
      host={host} details={fields.length || offer ? handoff.details.filter(line => line !== labels.onDesktop && !sameSite(host, line)) : handoff.details}
      fields={fields} values={values} onChange={(kind, value) => setValues({ ...values, [kind]: value })}
      onSubmit={() => void act()} pending={pending} offer={offer ?? undefined} onSave={save => void act(save)} />
  </DecisionCard>;
}

/** The hand-off card body: site, details, secure fields with their submit, and the save-sign-in prompt. */
export function BrowserHandoffForm({ labels, host, details, fields, values, onChange, onSubmit, pending, offer, onSave }: {
  labels: { fields: Record<InputKind, string>; submit: string; saveSignIn: string; later: string };
  host?: string; details: string[]; fields: InputKind[]; values: Partial<Record<InputKind, string>>;
  onChange(kind: InputKind, value: string): void; onSubmit(): void; pending?: HandoffPending;
  offer?: { username: string; host: string }; onSave(save: boolean): void;
}) {
  const canFill = fields.some(kind => values[kind]);
  return <>
    {host ? <Text literal>{host}</Text> : null}
    {details.map((line, index) => <Text key={index} literal>{line}</Text>)}
    {fields.map(kind => <TextField key={kind} label={labels.fields[kind]} value={values[kind] ?? ""}
      secureTextEntry={kind === "password"} autoComplete={kind === "otp" ? "one-time-code" : kind}
      keyboardType={kind === "otp" ? "number-pad" : undefined} returnKeyType="done" disabled={!!pending}
      onChangeText={value => onChange(kind, value)} onSubmitEditing={onSubmit} />)}
    {fields.length > 0 ? <ButtonGroup><Button label={labels.submit} disabled={!canFill || !!pending}
      loading={pending === "input"} onPress={onSubmit} /></ButtonGroup> : null}
    {offer ? <>
      <Text literal>{labels.saveSignIn} · {offer.username} · {offer.host}</Text>
      {fields.length ? <SaveButtons labels={labels} pending={pending} onSave={onSave} /> : null}
    </> : null}
  </>;
}

/** 나중에 / 로그인 저장: the card's own actions when saving is all that is left. */
export function SaveButtons({ labels, pending, onSave }: {
  labels: { saveSignIn: string; later: string }; pending?: HandoffPending; onSave(save: boolean): void;
}) {
  return <ButtonGroup layout="pair">
    <Button label={labels.later} variant="secondary" disabled={!!pending} onPress={() => onSave(false)} />
    <Button label={labels.saveSignIn} disabled={!!pending} loading={pending === "save"} onPress={() => onSave(true)} />
  </ButtonGroup>;
}

/** A site line the shown host already names (the host or its parent site). */
export function sameSite(host: string | undefined, line: string) {
  return Boolean(host && (host === line || host.endsWith(`.${line}`)));
}
