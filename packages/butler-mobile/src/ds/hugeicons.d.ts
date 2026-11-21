// @hugeicons/core-free-icons ships no per-icon declarations for its "./*" subpath exports.
declare module "@hugeicons/core-free-icons/*" {
  import type { IconSvgElement } from "@hugeicons/react-native";
  const glyph: IconSvgElement;
  export default glyph;
}
