import { Stack, useLocalSearchParams } from "expo-router";
import { LiveScreen } from "@/browserLive/LiveScreen";

export default function BrowserLiveRoute() {
  const { tabId, session, request } = useLocalSearchParams<{ tabId: string; session?: string; request?: string }>();
  return <>
    <Stack.Screen options={{ headerShown: false }} />
    <LiveScreen tabId={tabId} session={session ?? ""} request={request ?? ""} />
  </>;
}
