import { Host, Switch as ComposeSwitch } from "@expo/ui/jetpack-compose";
import { semantics, testID as testIDModifier } from "@expo/ui/jetpack-compose/modifiers";
import { useTokens } from "../design/useTokens";
import type { SwitchProps } from "./Switch";

export type { SwitchProps } from "./Switch";

export function Switch({ value, onValueChange, label, disabled, testID }: SwitchProps) {
  const t = useTokens();
  return (
    <Host matchContents>
      <ComposeSwitch
        value={value}
        onCheckedChange={onValueChange}
        enabled={!disabled}
        modifiers={[semantics({ contentDescription: label }), ...(testID ? [testIDModifier(testID)] : [])]}
        colors={{
          checkedTrackColor: t.color("--accent"),
          checkedThumbColor: t.color("--switch-thumb"),
          uncheckedTrackColor: t.color("--switch-track-bg"),
        }}
      />
    </Host>
  );
}
