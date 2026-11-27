import { useEffect, useId, useRef, useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { notifyStatus } from "@/app/notifications";
import { Button, ButtonContainer, ComposerDecisionPanel, Field, FieldLabel, Globe2, Input, Key, Square, Stack, Typo } from "@/butler-ds";
import type { ComposerAuthorityDecision, HandoffInput, InputKind } from "./useComposerAuthorityDecision";

export function ComposerBrowserHandoffSurface({ decision, placement }: { placement?: "composer" | "conversation"; decision: ComposerAuthorityDecision & Required<Pick<ComposerAuthorityDecision, "handoff">> }) {
  useAppLocale();
  const copy = appCopy.interfaceTemplates.approvalRequest.signInHandoff, browser = appCopy.browser;
  const { handoff } = decision, { loadInput } = handoff;
  const [input, setInput] = useState<HandoffInput>();
  const [values, setValues] = useState<Partial<Record<InputKind, string>>>({});
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false), formId = useId();
  useEffect(() => {
    let mounted = true;
    void loadInput().then(result => { if (mounted) setInput(result); }).catch(() => {});
    return () => { mounted = false; };
  }, [loadInput]);
  const fields = input?.fields ?? [], offer = input?.save_offer;
  const canFill = fields.some(kind => values[kind]);
  const host = input?.origin && URL.canParse(input.origin) ? new URL(input.origin).host : undefined;
  const act = async (save?: boolean) => {
    if (inFlight.current || decision.pending || (save === undefined && (!input || !canFill))) return;
    inFlight.current = true; setPending(true); setFailed(false);
    try {
      if (save === undefined && input) {
        const result = await handoff.fillInput(input.origin, values).finally(() => setValues({}));
        setFailed(result.status !== "filled");
        if (result.handed_back) handoff.onHandedBack();
      } else if (save !== undefined) {
        const result = await handoff.saveInput(save);
        if (save) notifyStatus(result.saved ? browser.signinSaved : browser.signinSaveFailed, { tone: result.saved ? "ok" : "error" });
        if (result.handed_back) handoff.onHandedBack();
      }
    } catch {
      if (save === undefined) setFailed(true);
      else if (save) notifyStatus(browser.signinSaveFailed, { tone: "error" });
    } finally {
      setInput(await loadInput().catch(() => undefined));
      inFlight.current = false; setPending(false);
    }
  };
  const save = <ButtonContainer size="sm" justify="end">
    <Button type="button" size="sm" variant="secondary" disabled={pending || decision.pending} onClick={() => void act(false)}>{browser.later}</Button>
    <Button type="button" size="sm" disabled={pending || decision.pending} onClick={() => void act(true)}>{browser.saveSignIn}</Button>
  </ButtonContainer>;
  // With fields the card's own 입력 replaces 입력 완료 (owner, 2026-11-27); 입력 완료 stays on the plain card.
  const buttons = <ButtonContainer size="sm" justify="end">
    <Button type="button" size="sm" variant="secondary" iconStart={<Square size="sm" />} onClick={handoff.onStop}>{copy.stop}</Button>
    {!fields.length && <Button type="button" size="sm" variant={handoff.canOpenTab ? "secondary" : "default"} disabled={decision.pending || pending} onClick={handoff.onDone}>{copy.done}</Button>}
    {handoff.canOpenTab && <Button type="button" size="sm" variant={fields.length ? "secondary" : "default"} onClick={handoff.onOpenTab}>{copy.openTab}</Button>}
    {fields.length > 0 && <Button type="button" size="sm" disabled={!canFill || pending || decision.pending} onClick={() => void act()}>{copy.submit}</Button>}
  </ButtonContainer>;
  return <ComposerDecisionPanel placement={placement} media={decision.media}
    icon={handoff.signIn ? <Key aria-hidden="true" size="lg" /> : <Globe2 aria-hidden="true" size="lg" />}
    eyebrow={copy.eyebrow} title={decision.title} details={host && (fields.length || offer) ? [host, ...decision.details.filter(line => typeof line !== "string" || line !== copy.onDesktop && line !== host && !host.endsWith(`.${line}`))] : decision.details}
    error={failed ? browser.signinFillFailed : decision.error} onOpen={decision.onOpenSource}
    aside={decision.pendingCount > 1 ? <Typo.Caption>+{decision.pendingCount - 1}</Typo.Caption> : undefined}
    data-test-class="composer-browser-handoff"
    form={fields.length || offer ? <Stack fill gap="sm">
      {fields.map(kind => <Field key={kind}>
        <FieldLabel htmlFor={formId + kind}>{copy.fields[kind]}</FieldLabel>
        <Input id={formId + kind} type={kind === "password" ? "password" : "text"}
          inputMode={kind === "otp" ? "numeric" : undefined} autoComplete={{ username: "username", password: "current-password", otp: "one-time-code" }[kind]}
          value={values[kind] ?? ""} disabled={pending} onChange={event => setValues({ ...values, [kind]: event.target.value })}
          onKeyDown={event => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault(); event.stopPropagation(); void act();
          }} />
      </Field>)}
      {offer && <Typo.Label literal>{copy.savePrompt(offer.username)}</Typo.Label>}
      {offer && fields.length > 0 && save}
    </Stack> : undefined}
    actions={offer && !fields.length ? save : buttons}
  />;
}
