import { Stack } from "expo-router";
import { ToastHost } from "@/ds";

export default function RootLayout() {
  return (
    <>
      <Stack screenOptions={{ headerShown: false }} />
      <ToastHost />
    </>
  );
}
