import { useEffect, useState } from "react";
import { PUSH_KINDS, type PushKind } from "@/connection/pairings";
import { pairingStore } from "@/connection/store";
import { useConversation } from "@/conversation/live";
import { ListGroup, showToast } from "@/ds";
import { useMobileCopy } from "@/i18n";
import { disablePush, enablePush, setPushKinds } from "@/notifications/push";
import { SettingsScreen } from "@/settings/layout";
import { SwitchRow } from "@/settings/rows";

export default function NotificationsSettings() {
  const copy = useMobileCopy();
  const { client, pairing } = useConversation();
  const [push, setPush] = useState(false);
  const [kinds, setKinds] = useState<PushKind[]>([...PUSH_KINDS]);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void pairingStore.loadActive().then(active => {
      setPush(active?.pushEnabled === true);
      setKinds(active?.pushKinds ?? [...PUSH_KINDS]);
    });
  }, [pairing]);
  useEffect(() => {
    if (!client) return;
    void client.request<{ available: boolean }>("/devices/self/push").then(v => setAvailable(v.available), () => setAvailable(null));
  }, [client]);
  const off = !client || !pairing || available === false;

  async function toggle(on: boolean) {
    if (!client || !pairing) return;
    setBusy(true);
    try {
      const ok = on ? await enablePush(client, pairing.butlerId) : await disablePush(client, pairing.butlerId);
      if (ok) setPush(on);
      else showToast({ message: copy.settings.notificationsFailed, tone: "warning" });
    } finally {
      setBusy(false);
    }
  }

  async function toggleKind(kind: PushKind, on: boolean) {
    if (!client || !pairing) return;
    const next = PUSH_KINDS.filter(k => k === kind ? on : kinds.includes(k));
    setBusy(true);
    try {
      if (await setPushKinds(client, pairing.butlerId, next)) setKinds(next);
      else showToast({ message: copy.settings.notificationsFailed, tone: "warning" });
    } finally {
      setBusy(false);
    }
  }

  return <SettingsScreen title={copy.settings.notifications}>
    <ListGroup footer={available === false ? copy.settings.notificationsSignIn : undefined}>
      <SwitchRow title={copy.settings.notificationsReceive} value={push} disabled={off || busy} onChange={on => void toggle(on)} />
    </ListGroup>
    <ListGroup>
      {PUSH_KINDS.map(kind => <SwitchRow key={kind} title={copy.settings.notificationKinds[kind]}
        value={kinds.includes(kind)} disabled={off || !push || busy} onChange={on => void toggleKind(kind, on)} />)}
    </ListGroup>
  </SettingsScreen>;
}
