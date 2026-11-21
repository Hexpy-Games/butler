import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { ImageViewerHost } from "@/conversation/ImageViewerHost";
import { ConversationProvider } from "@/conversation/live";
import { ToastHost } from "@/ds";

export default function RootLayout() {
  return (
    <>
      <StatusBar style="auto" />
      <ConversationProvider>
        <Stack screenOptions={{ headerShown: false }} />
        <ImageViewerHost />
      </ConversationProvider>
      <ToastHost />
    </>
  );
}
