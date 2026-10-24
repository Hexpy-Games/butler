/** Default outer bounds in Electron display-independent pixels. */
export function defaultWindowBounds(workArea) {
  const width = Math.min(1440, Math.floor(workArea.width * 0.9));
  const height = Math.min(900, Math.floor(workArea.height * 0.9));
  return {
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
    width,
    height,
  };
}
