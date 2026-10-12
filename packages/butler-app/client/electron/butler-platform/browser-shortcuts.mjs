/** OS-specific pick modifier belongs at the desktop platform boundary. */
export function isPickShortcut(input, platform = process.platform) {
  return input.type === "keyDown" && input.shift && !input.alt &&
    (platform === "darwin" ? input.meta && !input.control : input.control && !input.meta) && input.key.toLowerCase() === "s";
}

/** Browser history is available from App chrome and native pages. */
export function isHistoryShortcut(input, platform = process.platform) {
  return input.type === "keyDown" && !input.shift && !input.alt &&
    (platform === "darwin" ? input.meta && !input.control && input.key.toLowerCase() === "y"
      : input.control && !input.meta && input.key.toLowerCase() === "h");
}
