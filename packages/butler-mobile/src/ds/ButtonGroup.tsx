/**
 * Mobile action buttons. Never aligned to one side.
 * - "stack": one full-width button per row, primary first (top). For a single button and for alternatives that are not opposites.
 * - "pair": exactly two buttons, equal halves of one row. Negative/cancel first (leading), affirmative second (trailing);
 *   RTL mirrors through row direction. For opposing decisions: Cancel / Retry, Decline / Accept.
 * - Never more than two per row. Emphasis by variant (default vs secondary), never by size.
 */
import { Children } from "react";
import { View } from "react-native";
import { useTokens } from "../design/useTokens";

export type ButtonGroupLayout = "stack" | "pair";

export interface ButtonGroupProps {
  /** Buttons in visual order; "pair" takes exactly two. null/false children are skipped. */
  children: React.ReactNode;
  layout?: ButtonGroupLayout;
  testID?: string;
}

export function ButtonGroup({ children, layout = "stack", testID }: ButtonGroupProps) {
  const t = useTokens();
  const pair = layout === "pair";
  return (
    <View testID={testID} style={{ flexDirection: pair ? "row" : "column", alignItems: "stretch", gap: t.length("--space-3") }}>
      {pair ? Children.toArray(children).map((item, i) => <View key={i} style={{ flex: 1 }}>{item}</View>) : children}
    </View>
  );
}
