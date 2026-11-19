import * as Device from "expo-device";
import { Platform } from "react-native";
import { pairDeviceName, type PairPlatform } from "./pair";

export function thisDevice(): { name: string; platform: PairPlatform } {
  const platform = Platform.OS === "ios" ? "ios" : "android";
  const name = pairDeviceName([Device.deviceName, Device.modelName], platform === "ios" ? "iOS" : "Android");
  return { name, platform };
}
