import { useEffect, useRef, type ComponentRef, type RefObject } from "react";
import { Keyboard, TextInput } from "react-native";
import { textDiff, type InputQueue } from "./input";

export function LiveKeyboard({ input, queue }: {
  input: RefObject<ComponentRef<typeof TextInput> | null>; queue: InputQueue;
}) {
  const buffer = useRef("");
  const clear = () => {
    buffer.current = "";
    input.current?.clear();
  };

  useEffect(() => {
    const hide = Keyboard.addListener("keyboardDidHide", () => input.current?.blur());
    return () => hide.remove();
  }, [input]);

  return <TextInput
    ref={input}
    style={{ position: "absolute", width: 1, height: 1, opacity: 0 }}
    accessibilityElementsHidden
    importantForAccessibility="no-hide-descendants"
    pointerEvents="none"
    autoCorrect={false}
    autoCapitalize="none"
    spellCheck={false}
    blurOnSubmit={false}
    onBlur={clear}
    onChangeText={next => {
      const { backspaces, insert } = textDiff(buffer.current, next);
      buffer.current = next;
      for (let i = 0; i < backspaces; i++) queue.push({ t: "key", key: "Backspace" });
      if (insert) queue.push({ t: "text", value: insert });
    }}
    onKeyPress={({ nativeEvent }) => {
      if (nativeEvent.key === "Backspace" && !buffer.current) queue.push({ t: "key", key: "Backspace" });
    }}
    onSubmitEditing={() => {
      queue.push({ t: "key", key: "Enter" });
      clear();
    }}
  />;
}
