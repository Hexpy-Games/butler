import { Platform, Switch as NativeSwitch } from "react-native";
import { useTokens } from "../design/useTokens";

export interface SwitchProps {
  value: boolean;
  onValueChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
  testID?: string;
}

/** The platform switch: UISwitch on iOS, the Material switch on Android. iOS keeps its system off track. */
export function Switch({ value, onValueChange, label, disabled, testID }: SwitchProps) {
  const t = useTokens();
  return (
    <NativeSwitch
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      accessibilityLabel={label}
      testID={testID}
      trackColor={{ true: t.color("--accent"), false: Platform.select({ android: t.color("--switch-track-bg") }) }}
    />
  );
}
