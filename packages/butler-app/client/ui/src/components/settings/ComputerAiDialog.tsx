import { useMemo, useState } from "react";
import { apiErrorCode } from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import { notifyError, notifyStatus } from "@/app/notifications.ts";
import type { SavedCredentialView } from "@/app/types";
import {
  Button, ButtonContainer, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  SettingsField, SettingsFieldGroup, SettingsFieldScopeProvider, Tooltip,
} from "@/butler-ds";
import { ChatGptSignInCard } from "@/components/chatgpt/ChatGptSignInCard";
import { useSignIn } from "@/components/first-run/useSignIn";
import { ComputerModelFields } from "./ComputerModelFields";
import { computerSignInTransport, updateComputerModel, type Computer } from "./computersApi";
import { useComputerModelChoice } from "./hooks/useComputerModelChoice";

export function ComputerAiDialog({ computer, savedKeys, onClose }: {
  computer: Computer | null;
  savedKeys: SavedCredentialView[];
  onClose(): void;
}) {
  const copy = appCopy.computers.model;
  const model = useComputerModelChoice(computer?.model_source ?? "none");
  const [saving, setSaving] = useState(false);
  const transport = useMemo(() => computerSignInTransport(computer?.id ?? ""), [computer?.id]);
  const signIn = useSignIn({ onSignedIn: connected, transport });
  const waiting = signIn.phase === "starting" || signIn.phase === "waiting";

  function connected() {
    notifyStatus(copy.connected, { id: "computers", tone: "ok" });
    onClose();
  }

  function close() {
    signIn.leave();
    onClose();
  }

  async function save() {
    if (!computer || !model.ready || saving) return;
    setSaving(true);
    try {
      const source = model.source;
      const result = await updateComputerModel(computer.id, source);
      if ((source === "follow" || typeof source === "object") && !result.ai_connected) {
        notifyStatus(copy.syncFailed, { id: "computers", tone: "error" });
      } else {
        notifyStatus(copy.saved, { id: "computers", tone: "ok" });
      }
    } catch (error) {
      const code = apiErrorCode(error);
      notifyError(error, ["credential_not_found", "computer_not_found", "not_found", "invalid_json"].includes(code ?? "")
        ? copy.saveFailed : copy.syncFailed, { id: "computers" });
    }
    onClose();
  }

  return (
    <Dialog open={computer !== null} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent closeLabel={appCopy.common.close} data-test-class="computer-ai-dialog">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description(computer?.name ?? "")}</DialogDescription>
        </DialogHeader>
        <SettingsFieldScopeProvider>
          <SettingsFieldGroup>
            {!waiting && <ComputerModelFields model={model} savedKeys={savedKeys} busyReason={saving ? appCopy.settings.security.working : undefined} />}
            {model.choice === "chatgpt" && (
              <SettingsField label={copy.signIn} controlWidth="full" control={<ChatGptSignInCard signIn={signIn} account={null} />} />
            )}
          </SettingsFieldGroup>
        </SettingsFieldScopeProvider>
        <DialogFooter>
          <ButtonContainer size="default" justify="end">
            {waiting ? (
              <Button type="button" variant="outline" onClick={() => void signIn.cancel()}>{appCopy.common.cancel}</Button>
            ) : <>
              <Button type="button" variant="outline" onClick={close}>{appCopy.common.cancel}</Button>
              <Tooltip label={saving ? appCopy.settings.security.working : !model.ready ? copy.chooseKeyFirst : undefined}>
                <Button type="button" disabled={!model.ready || saving} onClick={() => void save()}>{copy.save}</Button>
              </Tooltip>
            </>}
          </ButtonContainer>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
