import { useCallback, useEffect, useState } from "react";
import { AppState, Linking } from "react-native";
import { getPermissionsAsync, type NotificationPermissionsStatus } from "expo-notifications";
import { useFocusEffect } from "expo-router";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { PUSH_KINDS, type PushKind } from "@/connection/pairings";
import { pairingStore } from "@/connection/store";
import { useConversation } from "@/conversation/live";
import { ListGroup, ListRow, showToast } from "@/ds";
import { useAppLocale } from "@/i18n";
import { disablePush, enablePush, setPushKinds } from "@/notifications/push";
import { SettingsScreen } from "@/settings/layout";
import { SwitchRow } from "@/settings/rows";

export default function NotificationsSettings() {
  const app = getAppCopy(useAppLocale());
  const copy = app.mobile;
  const { client, pairing } = useConversation();
  const [push, setPush] = useState(false);
  const [kinds, setKinds] = useState<PushKind[]>([...PUSH_KINDS]);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [permission, setPermission] = useState<NotificationPermissionsStatus | null>(null);
  const refreshPermission = useCallback(() => getPermissionsAsync().then(setPermission, () => {}), []);
  useFocusEffect(useCallback(() => {
    void refreshPermission();
    const subscription = AppState.addEventListener("change", state => {
      if (state === "active") void refreshPermission();
    });
    return () => subscription.remove();
  }, [refreshPermission]));
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
  const denied = permission?.status === "denied";
  const needsSettings = denied && !permission.canAskAgain;

  async function toggle(on: boolean) {
    if (!client || !pairing) return;
    setBusy(true);
    try {
      const ok = on ? await enablePush(client, pairing.butlerId) : await disablePush(client, pairing.butlerId);
      if (ok) setPush(on);
      else showToast({ message: copy.settings.notificationsFailed, tone: "warning" });
    } finally {
      if (on) await refreshPermission();
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
    {needsSettings ? <ListGroup footer={copy.settings.notificationsPermissionFooter}>
      <ListRow title={copy.settings.notificationsAllow} meta={app.automations.off} navigates onPress={() => void Linking.openSettings()} />
    </ListGroup> : <ListGroup footer={available === false ? copy.settings.notificationsSignIn : undefined}>
      <SwitchRow title={copy.settings.notificationsAllow} value={push} disabled={available === false || busy || !client || !pairing} onChange={on => void toggle(on)} />
    </ListGroup>}
    {push && available !== false && !denied ? <ListGroup label={copy.settings.notificationsKindsTitle}>
      {PUSH_KINDS.map(kind => <SwitchRow key={kind} title={copy.settings.notificationKinds[kind]}
        value={kinds.includes(kind)} disabled={busy} onChange={on => void toggleKind(kind, on)} />)}
    </ListGroup> : null}
  </SettingsScreen>;
}
