import { useRef, type ComponentRef } from "react";
import { View } from "react-native";
import { BlurTargetView } from "expo-blur";
import { GlassTarget } from "./internal/GlassFill";

export interface GlassBackdropProps {
  children: React.ReactNode;
  overlay: React.ReactNode;
}

/** The blur target: glass in `overlay` blurs `children`, the content it floats over. */
export function GlassBackdrop({ children, overlay }: GlassBackdropProps) {
  const ref = useRef<ComponentRef<typeof View>>(null);
  return (
    <View style={{ flex: 1 }}>
      <BlurTargetView ref={ref} style={{ flex: 1 }}>{children}</BlurTargetView>
      <GlassTarget.Provider value={ref}>{overlay}</GlassTarget.Provider>
    </View>
  );
}
