import { Stack } from "expo-router";

// Screens arrive with the mobile design system; this is only the navigation root.
export default function RootLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
