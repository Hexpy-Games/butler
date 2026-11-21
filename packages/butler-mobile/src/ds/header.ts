import { Platform } from "react-native";
import { useHeaderHeight } from "expo-router/react-navigation";
import type { NativeStackNavigationOptions } from "expo-router";
import { useTokens } from "../design/useTokens";
import { fontFace, weightValue } from "./internal/typography";

export function useHeaderOptions(backgroundColor?: string): NativeStackNavigationOptions {
  const t = useTokens();
  const title = { fontFamily: fontFace(weightValue(t, "semibold")), color: t.color("--text-primary") };
  return {
    headerShown: true,
    headerTitleStyle: title,
    headerLargeTitleStyle: title,
    headerTintColor: t.color("--text-primary"),
    headerShadowVisible: false,
    headerBackButtonDisplayMode: "minimal",
    ...(Platform.OS === "ios" ? {
      headerTransparent: true,
      ...(parseInt(String(Platform.Version), 10) >= 26
        ? { scrollEdgeEffects: { top: "soft", bottom: "soft" } as const }
        : { headerBlurEffect: "systemChromeMaterial" as const }),
    } : { headerTransparent: false, headerStyle: { backgroundColor: backgroundColor ?? t.color("--color-surface-base") } }),
  };
}

/** Top padding a list needs under the header: the header overlays content only where it is transparent (iOS). */
export function useHeaderInset(): number {
  const height = useHeaderHeight();
  return Platform.OS === "ios" ? height : 0;
}
