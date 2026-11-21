import { UITextView } from "@bsky.app/react-native-uitextview";
import { Children } from "react";
import { Platform, Text as RNText, type TextProps } from "react-native";
import { keepHangulWords } from "./typography";

/** Every DS text: Hangul breaks by word (web DS keep-all), on both platforms. */
export function BaseText({ children, ...props }: TextProps) {
  const items = Children.toArray(children);
  const body = Platform.OS === "android" && !props.selectable
    ? items.every(c => typeof c === "string" || typeof c === "number")
      ? keepHangulWords(items.join(""))
      : Children.map(children, (child) => (typeof child === "string" ? keepHangulWords(child) : child))
    : children;
  const Component = Platform.OS === "ios" ? UITextView : RNText;
  return <Component uiTextView lineBreakStrategyIOS="hangul-word" {...props}>{body}</Component>;
}
