import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { ImageViewerHost } from "@/conversation/ImageViewerHost";
import { ConversationProvider } from "@/conversation/live";
import { ToastHost, useTokens } from "@/ds";
import { PushRouting } from "@/notifications/PushRouting";

export default function RootLayout() {
  const t = useTokens();
  const base = t.scheme === "dark" ? DarkTheme : DefaultTheme;
  const backgroundColor = t.color("--color-surface-base");
  const theme = {
    ...base,
    colors: {
      ...base.colors,
      background: backgroundColor,
      card: backgroundColor,
      text: t.color("--text-primary"),
      border: t.color("--line"),
      primary: t.color("--accent"),
    },
  };
  return (
    <>
      <StatusBar style="auto" />
      <ConversationProvider>
        <ThemeProvider value={theme}>
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor } }} />
        </ThemeProvider>
        <ImageViewerHost />
        <PushRouting />
      </ConversationProvider>
      <ToastHost />
    </>
  );
}
