import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import type { Href } from "expo-router";
import { AppState } from "react-native";
import type { GatewayClient } from "../../../butler-protocol/src/client/index.ts";
import { PUSH_KINDS, stringField, type PushKind } from "@/connection/pairings";
import { pairingStore } from "@/connection/store";
import { pushLang } from "@/i18n";
import { openChat } from "./openChat";

Notifications.setNotificationHandler({
  handleNotification: async n => {
    const id = n.request.content.data?.session_id;
    const hide = AppState.currentState === "active" && typeof id === "string" && id === openChat();
    return { shouldShowBanner: !hide, shouldShowList: !hide, shouldPlaySound: !hide, shouldSetBadge: false };
  },
});

async function expoToken(): Promise<string | null> {
  try {
    const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
    return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  } catch {
    return null;
  }
}

export async function enablePush(client: GatewayClient, butlerId: string): Promise<boolean> {
  try {
    if (!(await Notifications.requestPermissionsAsync()).granted) return false;
    const token = await expoToken();
    if (token === null) return false;
    const active = await pairingStore.loadActive();
    const kinds = active?.butlerId === butlerId && active.pushKinds ? active.pushKinds : [...PUSH_KINDS];
    const lang = pushLang();
    await client.request<void>("/devices/self/push", { method: "PUT", body: { token, lang, kinds } });
    await pairingStore.setPush(butlerId, { pushEnabled: true });
    return true;
  } catch {
    return false;
  }
}

export async function disablePush(client: GatewayClient, butlerId: string): Promise<boolean> {
  try {
    await client.request<void>("/devices/self/push", { method: "PUT", body: { token: null } });
    await pairingStore.setPush(butlerId, { pushEnabled: false });
    return true;
  } catch {
    return false;
  }
}

export async function syncPush(client: GatewayClient, butlerId: string): Promise<void> {
  try {
    const pairing = await pairingStore.loadActive();
    if (pairing?.butlerId !== butlerId || !pairing.pushEnabled) return;
    if (!(await Notifications.getPermissionsAsync()).granted) return;
    const token = await expoToken();
    if (token === null) return;
    const lang = pushLang();
    await client.request<void>("/devices/self/push", { method: "PUT", body: { token, lang, kinds: pairing.pushKinds ?? [...PUSH_KINDS] } });
  } catch {
    // Registration is best-effort on startup.
  }
}

export async function setPushKinds(client: GatewayClient, butlerId: string, kinds: PushKind[]): Promise<boolean> {
  try {
    const token = await expoToken();
    if (token === null) return false;
    await client.request<void>("/devices/self/push", { method: "PUT", body: { token, lang: pushLang(), kinds } });
    await pairingStore.setPush(butlerId, { pushKinds: kinds });
    return true;
  } catch {
    return false;
  }
}

export function routeOf(data: unknown): Href | null {
  if (data === null || typeof data !== "object") return null;
  const session = stringField(data, "session_id");
  if (session) return { pathname: "/chat/[id]", params: { id: session } };
  const automation = stringField(data, "automation_id");
  return automation ? { pathname: "/automations/[id]", params: { id: automation } } : null;
}
