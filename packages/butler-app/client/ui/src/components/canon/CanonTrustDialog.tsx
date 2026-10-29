import { useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { decideCanonGrant, useCanonGrants } from "@/app/canonTrust.ts";
import { notifyError } from "@/app/notifications.ts";
import { Button, ButtonContainer, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, KeyValueRow, Notice, ScrollArea, Stack, Typo } from "@/butler-ds";
import { useCanonPersonName } from "./useCanonPersonName.ts";
export function CanonTrustDialog() {
  useAppLocale();
  const { grants, refresh } = useCanonGrants(true);
  const person = useCanonPersonName();
  const [busy, setBusy] = useState(false);
  const grant = grants?.[0];
  if (!grant) return null;
  const copy = appCopy.canon.mcp;
  const decide = async (action: "allow" | "deny") => {
    if (busy) return;
    setBusy(true);
    try { await decideCanonGrant(grant.id, action); await refresh(); }
    catch (error) { notifyError(error, appCopy.interfaceFeedback.requestFailed); }
    finally { setBusy(false); }
  };
  return <Dialog open><DialogContent showCloseButton={false} size="sm" layout="scroll-body" maxHeight="3/5"
    onEscapeKeyDown={event => event.preventDefault()} onPointerDownOutside={event => event.preventDefault()}>
    <DialogHeader><DialogTitle>{copy.trustTitle(grant.client_title)}</DialogTitle>
      <DialogDescription>{copy.trustDescription}</DialogDescription></DialogHeader>
    <ScrollArea fill><Stack gap="sm">
      <KeyValueRow label={copy.client} value={null} detailLayout="stack" detailAlign="start"
        description={<Stack as="span" gap="none" cross="start"><Typo.Body as="span" tone="primary">{grant.client_title}</Typo.Body></Stack>} />
      <KeyValueRow label={copy.person} value={null} detailLayout="stack" detailAlign="start"
        description={<Stack as="span" gap="none" cross="start"><Typo.Body as="span" tone="primary">{person}</Typo.Body></Stack>} />
      {grant.requested.map(capability => <Typo.Body key={capability}>{copy.capabilities[capability] ?? capability}</Typo.Body>)}
      <Notice tone="info" message={copy.trustNotice(person)} />
    </Stack></ScrollArea>
    <DialogFooter><ButtonContainer size="sm" justify="end">
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void decide("deny")}>{copy.deny}</Button>
      <Button size="sm" disabled={busy} onClick={() => void decide("allow")}>{copy.allow}</Button>
    </ButtonContainer></DialogFooter>
  </DialogContent></Dialog>;
}
