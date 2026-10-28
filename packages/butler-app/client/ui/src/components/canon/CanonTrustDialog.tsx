import { useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { decideCanonGrant, useCanonGrants } from "@/app/canonTrust.ts";
import { notifyError } from "@/app/notifications.ts";
import { Button, ButtonContainer, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, KeyValueRow, ListRow, Notice, ScrollArea, Stack } from "@/butler-ds";
import { useCanonPersonName } from "./useCanonPersonName.ts";
export function CanonTrustDialog() {
  useAppLocale();
  const { grants, remove, refresh } = useCanonGrants(true);
  const person = useCanonPersonName();
  const [busy, setBusy] = useState(false);
  const grant = grants?.[0];
  if (!grant) return null;
  const copy = appCopy.canon.mcp;
  const decide = async (action: "allow" | "deny") => {
    if (busy) return;
    setBusy(true);
    try { await decideCanonGrant(grant.id, action); remove(grant.id); await refresh(); }
    catch (error) { notifyError(error, appCopy.interfaceFeedback.requestFailed); }
    finally { setBusy(false); }
  };
  return <Dialog open><DialogContent showCloseButton={false} size="sm" layout="scroll-body" maxHeight="3/5"
    onEscapeKeyDown={event => event.preventDefault()} onPointerDownOutside={event => event.preventDefault()}>
    <DialogHeader><DialogTitle>{copy.trustTitle(grant.client_title)}</DialogTitle>
      <DialogDescription>{copy.trustDescription}</DialogDescription></DialogHeader>
    <ScrollArea fill><Stack gap="sm">
      <KeyValueRow label={copy.client} value={grant.client_title} />
      <KeyValueRow label={copy.person} value={person} />
      {grant.requested.map(capability => <ListRow key={capability} title={copy.capabilities[capability] ?? capability} />)}
      <Notice tone="info" message={copy.trustNotice(person)} />
    </Stack></ScrollArea>
    <DialogFooter><ButtonContainer size="sm" justify="end">
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void decide("deny")}>{copy.deny}</Button>
      <Button size="sm" disabled={busy} onClick={() => void decide("allow")}>{copy.allow}</Button>
    </ButtonContainer></DialogFooter>
  </DialogContent></Dialog>;
}
