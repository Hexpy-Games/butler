import { useRef, useState } from "react";
import { appCopy, useAppLocale } from "@/app/copy";
import { api } from "@/app/api";
import { useButlerStore } from "@/app/store";
import { notifyError } from "@/app/notifications";
import {
  Button, ButtonContainer, Dialog, DialogContent, DialogDescription, DialogHeader,
  DialogTitle, Stack, Tooltip,
} from "@/butler-ds";

export function ClearGeneralDialog({ open, onOpenChange, busy }: {
  open: boolean; onOpenChange(open: boolean): void; busy: boolean;
}) {
  const locale = useAppLocale();
  const [pending, setPending] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const clear = async () => {
    setPending(true);
    try {
      const result = await api<{ event_id: number }>("/sessions/general/clear", { method: "POST", body: JSON.stringify({
        title: appCopy.clearChat.archivedTitle(new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date())),
      }) });
      const store = useButlerStore.getState();
      store.resetGeneralConversation(result.event_id);
      store.openSession("general");
      onOpenChange(false);
      await store.refreshNavigation();
      await store.refreshSessionView("general");
    } catch (error) { notifyError(error, appCopy.clearChat.failed); }
    finally { setPending(false); }
  };
  return <Dialog open={open} onOpenChange={next => { if (!pending) onOpenChange(next); }}>
    <DialogContent closeLabel={appCopy.common.close} onOpenAutoFocus={event => { event.preventDefault(); cancel.current?.focus(); }}>
      <DialogHeader>
        <DialogTitle>{appCopy.clearChat.title}</DialogTitle>
        <DialogDescription>{appCopy.clearChat.description}{appCopy.clearChat.memory && <> {appCopy.clearChat.memory}</>}</DialogDescription>
      </DialogHeader>
      <Stack align="row" justify="between" cross="center" gap="sm" wrap>
        <Button size="sm" variant="link" disabled={pending} onClick={() => {
          onOpenChange(false); useButlerStore.getState().openSettings("memory");
        }}>{appCopy.clearChat.manageMemory}</Button>
        <ButtonContainer size="sm">
          <Button ref={cancel} size="sm" variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>{appCopy.common.cancel}</Button>
          <Tooltip label={busy ? appCopy.clearChat.busy : undefined}>
            <Button size="sm" disabled={pending || busy} onClick={() => { void clear(); }}>{appCopy.clearChat.clear}</Button>
          </Tooltip>
        </ButtonContainer>
      </Stack>
    </DialogContent>
  </Dialog>;
}
