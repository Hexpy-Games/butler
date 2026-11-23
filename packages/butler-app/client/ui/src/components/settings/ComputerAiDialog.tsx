import { useMemo, useState } from "react";
import { appCopy } from "@/app/copy.ts";
import { notifyError, notifyStatus } from "@/app/notifications.ts";
import type { SavedCredentialView } from "@/app/types";
import {
  Button, ButtonContainer, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  SettingsField, SettingsFieldGroup, SettingsFieldScopeProvider, Tooltip,
} from "@/butler-ds";
import { ChatGptSignInCard } from "@/components/chatgpt/ChatGptSignInCard";
import { useSignIn } from "@/components/first-run/useSignIn";
import { computerSignInTransport, sendComputerCredential, type Computer } from "./computersApi";
import { ProviderMark } from "./ProviderMark";
import { SettingsSelect } from "./SettingsSelect";

export function ComputerAiDialog({ computer, savedKeys, onClose }: {
  computer: Computer | null;
  savedKeys: SavedCredentialView[];
  onClose(result: "connected" | "later"): void;
}) {
  const copy = appCopy.computers.ai;
  const [key, setKey] = useState("");
  const [sending, setSending] = useState(false);
  const transport = useMemo(() => computerSignInTransport(computer?.id ?? ""), [computer?.id]);
  const signIn = useSignIn({ onSignedIn: connected, transport });
  const waiting = signIn.phase === "starting" || signIn.phase === "waiting";

  function connected() {
    notifyStatus(copy.connected, { id: "computers", tone: "ok" });
    onClose("connected");
  }

  function later() {
    signIn.leave();
    onClose("later");
  }

  async function send() {
    if (!computer || !key || sending) return;
    setSending(true);
    try {
      await sendComputerCredential(computer.id, key);
      connected();
    } catch (error) {
      notifyError(error, copy.sendFailed, { id: "computers" });
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={computer !== null} onOpenChange={(open) => { if (!open) later(); }}>
      <DialogContent closeLabel={appCopy.common.close} data-test-class="computer-ai-dialog">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description(computer?.name ?? "")}</DialogDescription>
        </DialogHeader>
        <SettingsFieldScopeProvider>
          <SettingsFieldGroup>
            <SettingsField label={copy.chatgpt} controlWidth="full" control={<ChatGptSignInCard signIn={signIn} account={null} />} />
            {!waiting && (
              <SettingsSelect controlWidth="full" label={copy.sendKey} description={copy.sendKeyHint}
                placeholder={copy.chooseKey} disabledReason={savedKeys.length ? undefined : copy.noSavedKeys}
                value={key} onChange={setKey} options={savedKeys.map((key) => ({
                  value: key.id, label: key.label, icon: <ProviderMark providerId={key.provider_id} besideProviderName />,
                }))}
              />
            )}
          </SettingsFieldGroup>
        </SettingsFieldScopeProvider>
        <DialogFooter>
          <ButtonContainer size="default" justify="end">
            {waiting ? (
              <Button type="button" variant="outline" onClick={() => void signIn.cancel()}>{appCopy.common.cancel}</Button>
            ) : <>
              <Button type="button" variant="outline" onClick={later}>{copy.later}</Button>
              <Tooltip label={sending ? appCopy.settings.security.working : !key ? copy.chooseKeyFirst : undefined}>
                <Button type="button" disabled={!key || sending} onClick={() => void send()}>{copy.send}</Button>
              </Tooltip>
            </>}
          </ButtonContainer>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
