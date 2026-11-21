import { useRef, useState } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import type { SessionBranchRequest, SessionBranchResult } from "../../../butler-protocol/src/index.ts";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { Button, Sheet, Spinner, Text, TextField, useTokens } from "@/ds";
import { useAppLocale, useMobileCopy } from "@/i18n";
import { useConversation } from "./live";
import { branchDestination } from "./documents";

export function BranchSheet({ sourceSessionId, sourceMessageId, project, projectId, onClose }: {
  sourceSessionId: string; sourceMessageId: string; project: boolean; projectId?: string; onClose(): void;
}) {
  const copy = useMobileCopy();
  const appCopy = getAppCopy(useAppLocale());
  const t = useTokens();
  const { client } = useConversation();
  const [title, setTitle] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const reservation = useRef<SessionBranchRequest | null>(null);
  const inFlight = useRef(false);
  const submit = async () => {
    if (!client || inFlight.current || !title.trim()) return;
    inFlight.current = true;
    setPending(true);
    setError(false);
    const request = reservation.current ?? { sourceSessionId, sourceMessageId, title: title.trim(),
      requestId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      destination: branchDestination(project, title.trim(), projectId) };
    reservation.current = request;
    try {
      const { session } = await client.request<SessionBranchResult>("/space/branches", { body: request });
      onClose();
      router.push({ pathname: "/chat/[id]", params: { id: session.id, title: session.title } });
    } catch { setError(true); }
    finally { inFlight.current = false; setPending(false); }
  };
  return <Sheet open onClose={() => { if (!pending) onClose(); }} dismissible={!pending}
    title={project ? appCopy.interfaceStatus.branchProject : appCopy.interfaceStatus.branchChat}
    description={appCopy.interfaceStatus.branchDescription} cancelLabel={copy.chat.close}
    action={<Button label={error ? appCopy.interfaceStatus.retry : appCopy.interfaceStatus.create}
      disabled={!title.trim() || pending} onPress={submit} />}>
    <View style={{ gap: t.length("--space-3") }}>
      <TextField label={project ? appCopy.interfaceStatus.projectName : appCopy.interfaceStatus.conversationTitle}
        value={title} onChangeText={setTitle} maxLength={120} disabled={reservation.current !== null} autoFocus />
      {pending ? <View style={{ flexDirection: "row", alignItems: "center", gap: t.length("--space-2") }}>
        <Spinner /><Text>{appCopy.interfaceStatus.branchPending}</Text>
      </View> : null}
      {error ? <Text tone="danger">{appCopy.interfaceDetails.branchFailed}</Text> : null}
    </View>
  </Sheet>;
}
