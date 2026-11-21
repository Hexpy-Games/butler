import { useState } from "react";
import { LayoutAnimation, Pressable, View } from "react-native";
import { OperationOutput, ThinkingDetails } from "../conversation/OperationOutput.tsx";
import { alpha, PILL } from "../design/tokens";
import { useTokens } from "../design/useTokens";
import { Icon } from "./Icon";
import { icons } from "./icons";
import { BaseText } from "./internal/BaseText";
import { useReducedMotion } from "./internal/motion";
import { usePress } from "./internal/press";
import { textStyle } from "./internal/typography";

export type WorkActivityToolIcon = "Rocket" | "FileText" | "Pencil" | "Terminal" | "Wrench" | "Search" | "ListChecks" | "AiChip";
export type WorkActivityToolItem = {
  id: string; icon: WorkActivityToolIcon; title: string; summaryLabel: string; details?: string;
  output?: { turnId: string; callId: string; resultId: string; toolName?: string; command?: string };
};

export function WorkActivityTools({ tools, compact }: { tools: WorkActivityToolItem[]; compact: boolean }) {
  return tools.length === 1 ? <ToolChip tool={tools[0]} compact={compact} /> : <ToolGroup tools={tools} compact={compact} />;
}

function ToolChip({ tool, compact, nested = false }: { tool: WorkActivityToolItem; compact: boolean; nested?: boolean }) {
  const t = useTokens();
  const reduced = useReducedMotion();
  const hasDetails = Boolean(tool.details || tool.output);
  const press = usePress({ scale: false, disabled: !hasDetails });
  const [expanded, setExpanded] = useState(false);
  const lineHeight = t.length(compact ? "--typo-caption-line-height" : "--typo-body-line-height");
  const padding = nested ? 0 : compact ? 2 : 5;
  const toggle = () => {
    if (!reduced) LayoutAnimation.configureNext({ duration: t.duration("--motion-base"), update: { type: "easeInEaseOut" },
      create: { type: "easeInEaseOut", property: "opacity" }, delete: { type: "easeInEaseOut", property: "opacity" } });
    setExpanded(value => !value);
  };
  const style = { flexDirection: "row", alignItems: "center", gap: t.length("--space-2"), alignSelf: "flex-start", maxWidth: "100%",
    paddingVertical: padding, paddingHorizontal: nested ? 0 : t.length("--space-2"),
    borderWidth: nested ? 0 : t.length("--border-hairline"), borderColor: t.color("--line"), borderRadius: t.length(PILL),
    backgroundColor: nested ? undefined : alpha(t.color("--surface"), 0.74), boxShadow: press.focused ? t.shadow("--focus-ring") : undefined,
  } as const;
  const body = <>
    <Icon glyph={icons[tool.icon]} size="md" tone="tertiary" />
    <BaseText numberOfLines={1} style={{ ...textStyle(t, compact ? "caption" : "body"), flexShrink: 1, color: alpha(t.color("--text-tertiary"), 0.78) }}>{tool.title}</BaseText>
    {nested && hasDetails ? <Icon glyph={expanded ? icons.ChevronDown : icons.ChevronRight} size="sm" tone="tertiary" /> : null}
  </>;
  return <View style={{ gap: t.length(compact ? "--space-1" : "--space-2") }}>
    {hasDetails ? <Pressable accessibilityRole="button" accessibilityLabel={tool.title} accessibilityState={{ expanded }}
      hitSlop={Math.max(0, (44 - lineHeight - padding * 2) / 2)} onPress={toggle} {...press.handlers} style={style}>{body}</Pressable>
      : <View style={style}>{body}</View>}
    {expanded ? <View style={{ paddingLeft: lineHeight + t.length("--space-2") }}>
      {tool.icon === "AiChip" ? <ThinkingDetails text={tool.details} turnId={tool.output?.turnId}
        requestId={tool.output?.callId} resultId={tool.output?.resultId} />
        : tool.output ? <OperationOutput {...tool.output} requestId={tool.output.callId} />
          : <BaseText style={{ ...textStyle(t, "caption"), color: alpha(t.color("--text-tertiary"), 0.78) }}>{tool.details}</BaseText>}
    </View> : null}
  </View>;
}

function ToolGroup({ tools, compact }: { tools: WorkActivityToolItem[]; compact: boolean }) {
  const t = useTokens();
  const reduced = useReducedMotion();
  const press = usePress({ scale: false });
  const [expanded, setExpanded] = useState(false);
  const padding = compact ? 2 : 5;
  const lineHeight = t.length(compact ? "--typo-caption-line-height" : "--typo-body-line-height");
  const toggle = () => {
    if (!reduced) LayoutAnimation.configureNext({ duration: t.duration("--motion-base"), update: { type: "easeInEaseOut" },
      create: { type: "easeInEaseOut", property: "opacity" }, delete: { type: "easeInEaseOut", property: "opacity" } });
    setExpanded(value => !value);
  };
  return <View>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={toggle} {...press.handlers}
      hitSlop={Math.max(0, (44 - lineHeight - padding * 2) / 2)}
      style={{ flexDirection: "row", alignItems: "center", alignSelf: "flex-start", maxWidth: "100%", gap: t.length("--space-2"),
        paddingVertical: padding, paddingHorizontal: t.length("--space-2"), borderWidth: t.length("--border-hairline"), borderRadius: t.length(PILL),
        borderColor: t.color(expanded || press.pressed ? "--line-strong" : "--line"),
        backgroundColor: expanded || press.pressed ? t.color("--selection") : alpha(t.color("--surface"), 0.74),
        boxShadow: press.focused ? t.shadow("--focus-ring") : undefined }}>
      <BaseText numberOfLines={1} style={{ ...textStyle(t, compact ? "caption" : "body"), flexShrink: 1, color: alpha(t.color("--text-tertiary"), 0.78) }}>{toolSummary(tools)}</BaseText>
      <Icon glyph={expanded ? icons.ChevronDown : icons.ChevronRight} size="sm" tone="tertiary" />
    </Pressable>
    {expanded ? <View style={{ marginTop: t.length("--space-2"), gap: t.length("--space-2") }}>
      {tools.map(tool => <ToolChip key={tool.id} tool={tool} compact={compact} nested />)}
    </View> : null}
  </View>;
}

function toolSummary(tools: WorkActivityToolItem[]): string {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    const label = tool.summaryLabel.trim();
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, count]) => `${count} ${label}`.trim()).join(", ");
}
