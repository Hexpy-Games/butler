import { View } from "react-native";
import { alpha, RADIUS } from "../design/tokens";
import { useTokens } from "../design/useTokens";

export interface MessageBubbleProps { children: React.ReactNode; variant?: "sent" | "queued" | "failed" }

const BUBBLE_PAD_V = 12; // owner decision 2026-11-20
const BUBBLE_PAD_H = 18;

export function MessageBubble({ children, variant = "sent" }: MessageBubbleProps) {
  const t = useTokens();
  return <View style={{
    borderRadius: t.length(RADIUS), paddingVertical: BUBBLE_PAD_V, paddingHorizontal: BUBBLE_PAD_H,
    backgroundColor: variant === "sent" ? t.color("--user-message-bg") : alpha(t.color("--user-message-bg"), 0.4),
    ...(variant === "sent" ? null : {
      borderWidth: t.length("--border-hairline"), borderStyle: "dashed",
      borderColor: t.color(variant === "failed" ? "--danger-line-strong" : "--line-strong"),
    }),
  }}>{children}</View>;
}
