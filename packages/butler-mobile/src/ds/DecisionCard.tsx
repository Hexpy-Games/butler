import type { ReactElement, ReactNode } from "react";
import { View } from "react-native";
import { useTokens } from "../design/useTokens";
import { Badge, type BadgeProps } from "./Badge";
import type { ButtonGroupProps } from "./ButtonGroup";
import { Surface } from "./Surface";
import { Text } from "./Text";

export interface DecisionCardProps {
  eyebrow: ReactNode;
  tag?: Pick<BadgeProps, "label" | "tone">;
  title: string;
  children?: ReactNode;
  actions: ReactElement<ButtonGroupProps>;
  footnote?: string;
}

export function DecisionCard({ eyebrow, tag, title, children, actions, footnote }: DecisionCardProps) {
  const t = useTokens();
  return <Surface variant="card" padding="lg">
    <View style={{ gap: t.length("--space-3") }}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: t.length("--space-2") }}>
        <Text variant="caption" tone="secondary">{eyebrow}</Text>
        {tag ? <Badge {...tag} /> : null}
      </View>
      <Text weight="semibold" literal>{title}</Text>
      {children}
      {actions}
      {footnote ? <Text variant="caption" tone="danger">{footnote}</Text> : null}
    </View>
  </Surface>;
}
