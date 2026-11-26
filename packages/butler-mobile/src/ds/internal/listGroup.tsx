import { createContext } from "react";
import { View } from "react-native";
import { useTokens } from "../../design/useTokens";

/** True for content inside a ListGroup card. Sheet resets it to false. */
export const InListGroup = createContext(false);

/** Grouped icon-to-title gap and ListGroupItem vertical padding (owner 2026-11-21). No 14 spacing token exists, and tokens.generated.json is generated from tokens.css, so the value lives here. */
export const GROUP_INNER_GAP = 14;

/** Top hairline of a grouped item: from the item's text edge to the card's inner padding (iOS grouped list). ListGroup clips the first item's line off the card. */
export function GroupDivider({ inset }: { inset: number }) {
  const t = useTokens();
  return <View pointerEvents="none"
    style={{ position: "absolute", top: 0, right: t.length("--space-5"), left: inset, height: t.length("--border-hairline"), backgroundColor: t.color("--line") }} />;
}
