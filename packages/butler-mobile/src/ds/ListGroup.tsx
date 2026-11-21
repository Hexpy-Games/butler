import { useContext } from "react";
import { View } from "react-native";
import { RADIUS } from "../design/tokens";
import { useTokens } from "../design/useTokens";
import { Text } from "./Text";
import { GroupDivider, GROUP_INNER_GAP, InListGroup } from "./internal/listGroup";

export interface ListGroupProps {
  label?: string;
  footer?: string;
  children: React.ReactNode;
  testID?: string;
}

export interface ListGroupItemProps {
  children: React.ReactNode;
}

/** A labelled card of rows: label above, inset hairlines between items, helper text below. */
export function ListGroup({ label, footer, children, testID }: ListGroupProps) {
  const t = useTokens();
  const hairline = t.length("--border-hairline");
  const text = { paddingHorizontal: t.length("--space-5") };
  return (
    <View testID={testID} style={{ gap: t.length("--space-2") }}>
      {label ? <View style={text}><Text variant="caption" tone="secondary" weight="medium">{label}</Text></View> : null}
      <View style={{
        backgroundColor: t.color("--surface-raised"), borderRadius: t.length(RADIUS),
        borderWidth: hairline, borderColor: t.color("--line"), overflow: "hidden",
      }}>
        <View style={{ overflow: "hidden" }}>
          <View style={{ marginTop: -hairline }}>
            <InListGroup.Provider value>{children}</InListGroup.Provider>
          </View>
        </View>
      </View>
      {footer ? <View style={text}><Text variant="caption" tone="secondary">{footer}</Text></View> : null}
    </View>
  );
}

/** Non-row content inside a ListGroup card: fields, buttons, status text, loading states. */
export function ListGroupItem({ children }: ListGroupItemProps) {
  const t = useTokens();
  const grouped = useContext(InListGroup);
  const pad = t.length("--space-5");
  return (
    <View style={{ paddingHorizontal: pad, paddingVertical: GROUP_INNER_GAP, gap: t.length("--space-2") }}>
      {grouped ? <GroupDivider inset={pad} /> : null}
      {children}
    </View>
  );
}
