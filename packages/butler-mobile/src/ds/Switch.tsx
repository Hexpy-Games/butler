import { Switch as NativeSwitch } from "react-native";
import { useTokens } from "../design/useTokens";

export interface SwitchProps {
  value: boolean;
  onValueChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
  testID?: string;
}

/** UISwitch; Android uses Switch.android.tsx (Material 3 via @expo/ui) */
export function Switch({ value, onValueChange, label, disabled, testID }: SwitchProps) {
  const t = useTokens();
  return (
    <NativeSwitch
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      accessibilityLabel={label}
      testID={testID}
      trackColor={{ true: t.color("--accent") }}
    />
  );
}
