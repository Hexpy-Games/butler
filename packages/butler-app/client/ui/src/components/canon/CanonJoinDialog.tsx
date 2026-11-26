import { useId, useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import {
  Button, ButtonContainer, Dialog, DialogContent, DialogDescription, DialogFooter, DialogForm, DialogHeader, DialogTitle,
  Field, FieldError, FieldLabel, Input, Skeleton, Spinner,
} from "@/butler-ds";
import { ButlerAccountSignInStep } from "../settings/ButlerAccountSignInStep.tsx";
import { useCanonJoin } from "./useCanonJoin.ts";

export function CanonJoinDialog({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  useAppLocale();
  const copy = appCopy.canon.online;
  const [code, setCode] = useState("");
  const [signIn, setSignIn] = useState(false);
  const codeId = useId();
  const { account, busy, failed, submit } = useCanonJoin(() => onOpenChange(false));
  return <>
    <Dialog open={!signIn} onOpenChange={open => { if (!busy) onOpenChange(open); }}>
      <DialogContent closeLabel={appCopy.common.close} glassRadius="composer" showCloseButton={!busy}>
        {account.state === "loading" ? <>
          <DialogTitle>{copy.join}</DialogTitle><Skeleton height="row" width="full" /><Skeleton height="row" width="full" />
        </> : account.state === "out" ? <>
          <DialogHeader><DialogTitle>{copy.join}</DialogTitle><DialogDescription>{copy.signInNeeded}</DialogDescription></DialogHeader>
          <DialogFooter><ButtonContainer size="sm" justify="end">
            <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>{appCopy.butlerAccount.cancel}</Button>
            <Button size="sm" onClick={() => setSignIn(true)}>{appCopy.butlerAccount.signIn}</Button>
          </ButtonContainer></DialogFooter>
        </> : <DialogForm dialog title={copy.join} busy={busy} onSubmit={() => void submit(code)}
          footer={<ButtonContainer size="default" justify="end">
            <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>{appCopy.common.cancel}</Button>
            <Button type="submit" disabled={!code.trim() || busy} iconStart={busy ? <Spinner size={14} /> : undefined}>{copy.joinAction}</Button>
          </ButtonContainer>}>
          <Field>
            <FieldLabel htmlFor={codeId}>{copy.joinCode}</FieldLabel>
            <Input id={codeId} autoFocus value={code} disabled={busy} onChange={event => setCode(event.target.value)} />
            {failed && <FieldError>{copy.joinFailed}</FieldError>}
          </Field>
        </DialogForm>}
      </DialogContent>
    </Dialog>
    {signIn && <ButlerAccountSignInStep onCancel={() => setSignIn(false)}
      onSignedIn={() => { setSignIn(false); void account.recheck(); }} />}
  </>;
}
