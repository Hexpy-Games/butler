import Svg, { Circle, Path } from "react-native-svg";

export function ButlerMark({ size, color }: { size: number; color: string }) {
  return <Svg width={size} height={size} viewBox="0 0 1200 1200">
    <Path d="M600 600 L300 464 A329.43 329.43 0 0 0 300 736 Z M600 600 L900 464 A329.43 329.43 0 0 1 900 736 Z"
      fill={color} stroke={color} strokeLinejoin="round" strokeWidth={68} />
    <Circle cx={600} cy={600} r={435} fill="none" stroke={color} strokeWidth={74} />
  </Svg>;
}
