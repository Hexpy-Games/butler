/** Bounded desktop timeline still; never attached to model context. */
export async function stepStill(tab) {
  if (tab.stills === false || !tab.view || tab.view.webContents.isDestroyed()) return undefined;
  const image = await tab.view.webContents.capturePage(undefined, { stayHidden: true }).catch(() => null);
  if (!image || image.isEmpty()) return undefined;
  const jpeg = image.resize({ width: 320 }).toJPEG(70);
  return jpeg.length <= 24 * 1024 ? { mime: "image/jpeg", base64: jpeg.toString("base64") } : undefined;
}
