import { Platform } from "react-native";

export const CODE_FONT = Platform.select({ ios: "Menlo", default: "monospace" });
