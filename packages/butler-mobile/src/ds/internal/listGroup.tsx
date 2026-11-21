import { createContext } from "react";
import { View } from "react-native";
import { useTokens } from "../../design/useTokens";

/** True for content inside a ListGroup card. Sheet resets it to false. */
export const InListGroup = createContext(false);

/** Top hairline of a grouped item, inset to the item's text edge. ListGroup clips the first item's line off the card. */
export function GroupDivider({ inset }: { inset: number }) {
  const t = useTokens();
  return <View pointerEvents="none"
    style={{ position: "absolute", top: 0, right: 0, left: inset, height: t.length("--border-hairline"), backgroundColor: t.color("--line") }} />;
}
