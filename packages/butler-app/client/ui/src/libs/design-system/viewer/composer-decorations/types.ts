export type DecorationTheme = "none" | "flowers" | "cherry" | "characters" | "coastal";
export interface DecorationSettings {
  theme: DecorationTheme;
  mode: "static" | "interactive";
  intensity: number;
  overflow: boolean;
  palette: "garden" | "dusk";
  wallpaper: boolean;
  phone: boolean;
}
export const initialSettings: DecorationSettings = {
  theme: "flowers", mode: "interactive", intensity: 55,
  overflow: true, palette: "garden", wallpaper: false, phone: false,
};
