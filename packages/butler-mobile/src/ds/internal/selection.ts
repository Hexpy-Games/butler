import { Platform } from "react-native";
/** iOS RN selectable Text offers only whole-node Copy; there the message long-press opens TextSelectSheet instead. */
export const inlineSelectable = Platform.OS !== "ios";
