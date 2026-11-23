import { useState } from "react";
import { appCopy } from "@/app/copy";
import {
  Button, ButtonContainer, CopyButton, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  Globe2, Input, ListRow, MetaList, SegmentedControl, Spinner, Stack, Tooltip, Typo,
} from "@/butler-ds";
import { openLink } from "../browser/browserBridge";
import type { LibraryItem } from "../browser/libraryStore";
import { formatArtifactSize } from "../artifacts/artifactDisplay";
import { ButlerAccountSignInDialog } from "../settings/ButlerAccountSignInDialog";
import { useButlerAccount } from "../settings/hooks/useButlerAccount";
import { closeLibraryDialogs } from "./libraryDialogs";
import { pageHost } from "./publishing";
import { usePublishDialog } from "./usePublishDialog";

function PublishSignIn({ onCancel, onSignedIn }: { onCancel: () => void; onSignedIn: () => void }) {
  const account = useButlerAccount();
  const verify: typeof account.verify = async (email, code) => {
    const result = await account.verify(email, code);
    if (result.ok) onSignedIn();
    return result;
  };
  return <ButlerAccountSignInDialog open onOpenChange={(open) => { if (!open) onCancel(); }} account={{ ...account, verify }} />;
}

export function PublishDialog({ item }: { item: LibraryItem }) {
  const state = usePublishDialog(item);
  const [signIn, setSignIn] = useState(false);
  const { stage, setStage, pages, preview, url, busy } = state;
  const copy = appCopy.publishing;
  const account = appCopy.butlerAccount;
  const cancel = <Button size="sm" variant="ghost" disabled={busy} onClick={closeLibraryDialogs}>{account.cancel}</Button>;
  const meta = preview && pages ? <MetaList items={[
    { label: copy.filesLabel, value: copy.files(preview.file_count, formatArtifactSize(preview.size_bytes)) },
    { label: copy.usageLabel, value: copy.usage(pages.used, pages.limit) },
  ]} /> : null;
  const body = (() => {
    if (stage === "loading") return { title: copy.title, description: item.title, content: <Spinner />, footer: cancel };
    if (stage === "signedOut") return { title: copy.title, description: copy.signInNeeded, content: null,
      footer: <>{cancel}<Button size="sm" onClick={() => setSignIn(true)}>{account.signIn}</Button></> };
    if (stage === "choose" || stage === "uploading") return { title: copy.title, description: item.title, content: <Stack gap="md">
      <SegmentedControl stretch ariaLabel={copy.title} value="public" onValueChange={() => {}}
        options={[{ value: "public", label: copy.publicOption, icon: <Globe2 size="sm" />, disabled: busy },
          { value: "private", label: copy.privateOption, disabledReason: copy.plusOnly }]} />
      <Typo.Caption tone="secondary">{copy.publicHint}</Typo.Caption>
      {meta}
      {pages?.badge ? <Typo.Caption tone="secondary">{copy.badgeNote}</Typo.Caption> : null}
    </Stack>, footer: <>{cancel}<Button size="sm" disabled={busy} iconStart={busy ? <Spinner size={14} /> : undefined}
      text={busy ? copy.uploading : copy.publish} onClick={state.publish} /></> };
    if (stage === "published" || stage === "updating") return { title: copy.title, description: item.title, content: <Stack gap="md">
      <Stack align="row" gap="sm" cross="center">
        <Stack grow minWidth="0"><Input readOnly value={url} aria-label={copy.link} /></Stack>
        <CopyButton label={copy.copyLink} copiedLabel={copy.linkCopied} text={url} />
      </Stack>
      {meta}
    </Stack>, footer: <>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setStage("stop")}>{copy.stop}</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void openLink(url)}>{copy.open}</Button>
      <Button size="sm" disabled={busy} iconStart={stage === "updating" ? <Spinner size={14} /> : undefined}
        text={stage === "updating" ? copy.uploading : copy.update} onClick={state.publish} />
    </> };
    if (stage === "stop") return { title: copy.stopConfirm, description: copy.stopBody, content: null,
      footer: <>{cancel}<Button size="sm" variant="destructive" disabled={busy} onClick={state.stop}>{copy.stop}</Button></> };
    const full = pages !== undefined && pages.used >= pages.limit;
    return { title: copy.title, description: pages ? copy.limitReached(pages.limit) : item.title, content: <Stack gap="sm">
      {pages?.pages.filter((page) => page.status === "live").map((page) => <Stack key={page.id} align="row" cross="center" gap="sm">
        <Stack grow minWidth="0"><ListRow icon={<Globe2 size="md" />} title={page.title} description={pageHost(page.url)} /></Stack>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => state.remove(page)}>{copy.unpublishOne}</Button>
      </Stack>)}
    </Stack>, footer: <>{cancel}{full ? <Tooltip label={copy.limitTooltip} side="bottom">
      <Button size="sm" disabled>{copy.publish}</Button></Tooltip>
      : <Button size="sm" disabled={busy || !pages} onClick={state.publish}>{copy.publish}</Button>}</> };
  })();

  return <>
    <Dialog open={!signIn} onOpenChange={(on) => { if (!on && !busy) closeLibraryDialogs(); }}>
      <DialogContent closeLabel={appCopy.common.close} showCloseButton>
        <DialogHeader><DialogTitle>{body.title}</DialogTitle><DialogDescription>{body.description}</DialogDescription></DialogHeader>
        {body.content}
        <DialogFooter><ButtonContainer size="sm">{body.footer}</ButtonContainer></DialogFooter>
      </DialogContent>
    </Dialog>
    {signIn ? <PublishSignIn onCancel={() => setSignIn(false)} onSignedIn={() => { setSignIn(false); state.reload(); }} /> : null}
  </>;
}
