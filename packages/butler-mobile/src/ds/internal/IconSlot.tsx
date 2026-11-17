import { useWindowDimensions, View } from "react-native";
import { maxFontScale } from "./typography";

/** A text line height scaled by the user's font size, capped at the controls' maximum. */
export function useScaledLine(lineHeight: number): number {
  const { fontScale } = useWindowDimensions();
  return lineHeight * Math.min(fontScale, maxFontScale.control);
}

/** A glyph column one text line tall. No background, border or tile behind the glyph. */
export function IconSlot({ size, lineHeight, children }: { size: number; lineHeight: number; children: React.ReactNode }) {
  const height = useScaledLine(lineHeight);
  return <View style={{ width: size, height, alignItems: "center", justifyContent: "center" }}>{children}</View>;
}
