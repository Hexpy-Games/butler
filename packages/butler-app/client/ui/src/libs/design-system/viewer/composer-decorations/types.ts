export type DecorationTheme = "none" | "flowers" | "cherry" | "characters";
export interface DecorationSettings {
  theme: DecorationTheme;
  mode: "static" | "interactive";
  intensity: number;
  placement: "inside" | "edge";
  overflow: boolean;
  palette: "garden" | "dusk";
  wallpaper: boolean;
  phone: boolean;
}
export const initialSettings: DecorationSettings = {
  theme: "flowers", mode: "interactive", intensity: 55, placement: "edge",
  overflow: true, palette: "garden", wallpaper: false, phone: false,
};
