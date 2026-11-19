import { Children } from "react";
import { Platform, Text as RNText, type TextProps } from "react-native";
import { keepHangulWords } from "./typography";

/** Every DS text: Hangul breaks by word (web DS keep-all), on both platforms. */
export function BaseText({ children, ...props }: TextProps) {
  const body = Platform.OS === "android" && !props.selectable
    ? Children.map(children, (child) => (typeof child === "string" ? keepHangulWords(child) : child))
    : children;
  return <RNText lineBreakStrategyIOS="hangul-word" {...props}>{body}</RNText>;
}
