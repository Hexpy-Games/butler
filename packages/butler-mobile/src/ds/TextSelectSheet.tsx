import { Platform, TextInput, useWindowDimensions } from "react-native";
import { useTokens } from "../design/useTokens";
import { fontFace, maxFontScale } from "./internal/typography";
import { Sheet } from "./Sheet";

export interface TextSelectSheetProps {
  open: boolean; onClose(): void; title: string; closeLabel: string; text: string;
}

export function TextSelectSheet({ open, onClose, title, closeLabel, text }: TextSelectSheetProps) {
  const t = useTokens();
  const { height } = useWindowDimensions();
  return <Sheet open={open} onClose={onClose} title={title} cancelLabel={closeLabel}>
    <TextInput multiline value={text} scrollEnabled
      // iOS keeps read-only selection; Android must stay enabled to select, with value restoring paste or cut.
      editable={Platform.OS === "ios" ? false : undefined}
      showSoftInputOnFocus={false}
      maxFontSizeMultiplier={maxFontScale.control}
      style={{ maxHeight: Math.round(height * 0.6), padding: 0, textAlignVertical: "top", color: t.color("--text-primary"),
        fontFamily: fontFace(t.number("--font-weight-regular")), fontSize: t.length("--typo-body-size"), lineHeight: t.length("--typo-body-line-height") }} />
  </Sheet>;
}
