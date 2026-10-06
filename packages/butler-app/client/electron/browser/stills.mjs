/** Bounded desktop timeline still; never attached to model context. */
export async function stepStill(tab) {
  if (tab.stills === false || !tab.view || tab.view.webContents.isDestroyed()) return undefined;
  if (!await painted(tab)) return undefined;
  const image = await tab.view.webContents.capturePage(undefined, { stayHidden: true }).catch(() => null);
  if (!image || image.isEmpty()) return undefined;
  const jpeg = image.resize({ width: 320 }).toJPEG(70);
  return jpeg.length <= 24 * 1024 ? { mime: "image/jpeg", base64: jpeg.toString("base64") } : undefined;
}

/** A native dialog pauses renderer scripts; it must fence paint without blocking approval. */
async function painted(tab) {
  const contents=tab.view.webContents;
  if(tab.dialog) return false;
  let interrupted;
  const dialog=new Promise(resolve=>{interrupted=(_event,method)=>{if(method==="Page.javascriptDialogOpening")resolve(false)};contents.debugger.on("message",interrupted)});
  try {
    const paint=contents.executeJavaScriptInIsolatedWorld(9001,[{code:"new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>done(true))))"}]).catch(()=>false);
    return await Promise.race([paint,dialog]);
  } finally {contents.debugger.removeListener("message",interrupted);}
}
