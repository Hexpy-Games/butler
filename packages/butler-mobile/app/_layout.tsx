import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { ToastHost } from "@/ds";

export default function RootLayout() {
  return (
    <>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false }} />
      <ToastHost />
    </>
  );
}
