export type DecorationTheme = "none" | "flowers" | "cherry" | "characters" | "coastal";
export interface DecorationSettings {
  theme: DecorationTheme;
  mode: "static" | "interactive";
  intensity: number;
  placement: "inside" | "edge";
  framing: "full" | "band";
  overflow: boolean;
  palette: "garden" | "dusk";
  wallpaper: boolean;
  phone: boolean;
}
export const initialSettings: DecorationSettings = {
  theme: "flowers", mode: "interactive", intensity: 55, placement: "edge", framing: "full",
  overflow: true, palette: "garden", wallpaper: false, phone: false,
};
