import { maskSecure } from "./capture.mjs";
import { guardedCapture, settledBitmap } from "./guarded-bitmap.mjs";

// Reuse only within the captured rendering frame. DOM revisions cannot fence
// CSSOM, decoded images or compositor animations. One rAF expires this receipt;
// there is no recurring renderer work while the browser is idle.
async function frameReceipt(tab) {
  return tab.view.webContents.executeJavaScriptInIsolatedWorld(9001, [{ code: `(()=>{
    const receipt={id:(globalThis.__butlerStillFrame?.id??0)+1,current:true};
    globalThis.__butlerStillFrame=receipt;requestAnimationFrame(()=>receipt.current=false);return receipt.id;
  })()` }]).catch(() => null);
}
async function sameFrame(tab, id) {
  return tab.view.webContents.executeJavaScriptInIsolatedWorld(9001, [{ code:
    `globalThis.__butlerStillFrame?.id===${JSON.stringify(id)}&&globalThis.__butlerStillFrame.current`,
  }]).catch(() => false);
}
const thumbnail = image => image.resize({ width: 160, height: 100 }).toBitmap();

/** Private comparison evidence; a failed or interrupted capture means unknown. */
export async function comparisonThumbnail(tab) {
  await tab.stillCapture;
  const still = tab.comparisonStill;
  tab.comparisonStill = undefined;
  if (tab.dialog || !tab.view || tab.view.webContents.isDestroyed()) return undefined;
  return guardedCapture(tab, async (contents, current) => {
    if (still && still.epoch === tab.epoch && still.frame !== null && await sameFrame(tab, still.frame)) {
      return current() ? still.thumb : undefined;
    }
    if (!current()) return undefined;
    const image = await settledBitmap(tab, contents, current);
    return image ? thumbnail(image.resize({ width: 320 })) : undefined;
  });
}

/** Bounded desktop timeline still; never attached to model context. */
export async function stepStill(tab, settled = false) {
  tab.comparisonStill = undefined;
  if (tab.dialog) return undefined;
  if (tab.stills === false) { tab.afterCapture?.(); return undefined; }
  return guardedCapture(tab, async (contents, current) => {
    let frame = null;
    let image = await settledBitmap(tab, contents, current, async () => { frame = await frameReceipt(tab); }, settled);
    if (!image) return undefined;
    const small = image.resize({ width: 320 });
    const thumb = thumbnail(small);
    if (tab.vaultFilled) image = await maskSecure(tab, image).catch(() => null);
    if (!current() || !image || image.isEmpty()) return undefined;
    tab.comparisonStill = { epoch: tab.epoch, frame, thumb };
    const jpeg = (tab.vaultFilled ? image.resize({ width: 320 }) : small).toJPEG(70);
    return jpeg.length <= 24 * 1024 ? { mime: "image/jpeg", base64: jpeg.toString("base64") } : undefined;
  });
}
