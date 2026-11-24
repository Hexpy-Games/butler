import { useId, useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import {
  Button, ButtonContainer, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  Field, FieldDescription, FieldLabel, ScrollArea, Skeleton, Spinner, Stack, Switch, Typo,
} from "@/butler-ds";
import { ButlerAccountSignInStep } from "../settings/ButlerAccountSignInStep.tsx";
import { CanonOnlineMembers } from "./CanonOnlineMembers.tsx";
import { useCanonOnlineDialog } from "./useCanonOnlineDialog.ts";

export function CanonOnlineDialog({ projectId, open, onOpenChange }: {
  projectId: string; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  useAppLocale();
  const copy = appCopy.canon.online;
  const [signIn, setSignIn] = useState(false);
  const switchId = useId();
  const state = useCanonOnlineDialog(projectId, () => onOpenChange(false));
  const { account, link, busy } = state;
  const owner = link?.role === "owner";
  return <>
    <Dialog open={open && !signIn} onOpenChange={onOpenChange}>
      <DialogContent size="md" layout="scroll-body" closeLabel={appCopy.common.close} data-test-class="canon-online-dialog">
        <DialogHeader><DialogTitle>{copy.title}</DialogTitle></DialogHeader>
        <ScrollArea fill>
          <Stack gap="lg">
            {account.state === "loading" ? <><Skeleton height="row" width="full" /><Skeleton height="row" width="full" /></>
              : account.state === "out" ? <DialogDescription>{copy.signInNeeded}</DialogDescription>
              : link?.state === "detached" ? <>
                <Typo.Body>{copy.detached}</Typo.Body>
                <ButtonContainer size="sm" justify="end"><Button size="sm" variant="outline" disabled={Boolean(busy)}
                  iconStart={busy === "unlink" ? <Spinner size={14} /> : undefined} onClick={() => void state.unlink()}>{copy.makeLocal}</Button></ButtonContainer>
              </> : <>
                {(!link || owner) && <Field>
                  <FieldLabel htmlFor={switchId}>{copy.switchLabel}</FieldLabel>
                  <FieldDescription>{copy.switchHelp}</FieldDescription>
                  <Switch id={switchId} checked={Boolean(link) || busy === "link"} disabled={Boolean(busy)}
                    onCheckedChange={checked => void (checked ? state.linkProject() : state.unlink())} />
                </Field>}
                {link && <CanonOnlineMembers state={state} owner={owner} />}
              </>}
          </Stack>
        </ScrollArea>
        {account.state === "out" && <DialogFooter><ButtonContainer size="sm" justify="end">
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>{appCopy.butlerAccount.cancel}</Button>
          <Button size="sm" onClick={() => setSignIn(true)}>{appCopy.butlerAccount.signIn}</Button>
        </ButtonContainer></DialogFooter>}
      </DialogContent>
    </Dialog>
    {signIn && <ButlerAccountSignInStep onCancel={() => setSignIn(false)}
      onSignedIn={() => { setSignIn(false); void account.recheck(); }} />}
  </>;
}
