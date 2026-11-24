import * as Notifications from "expo-notifications";
import { router, type Href } from "expo-router";
import { useEffect, useState } from "react";
import { useConversation } from "@/conversation/live";
import { routeOf, syncPush } from "./push";

const seen = new Set<string>();

export function PushRouting() {
  const { client, pairing } = useConversation();
  const [pending, setPending] = useState<Href | null>(null);

  useEffect(() => {
    function receive(response: Notifications.NotificationResponse | null) {
      if (response?.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
      const { identifier, content } = response.notification.request;
      if (seen.has(identifier)) return;
      seen.add(identifier);
      setPending(routeOf(content.data));
    }
    void Notifications.getLastNotificationResponseAsync().then(receive);
    const subscription = Notifications.addNotificationResponseReceivedListener(receive);
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (client && pending) {
      router.push(pending);
      setPending(null);
    }
  }, [client, pending]);

  useEffect(() => {
    if (client && pairing) void syncPush(client, pairing.butlerId);
  }, [client]);

  return null;
}
