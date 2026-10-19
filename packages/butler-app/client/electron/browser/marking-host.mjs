import { bitmapRgba, imageFromRgba } from "../butler-platform/bitmap.mjs";
import { app, WebContentsView } from "electron";

let host;
let ready;
let queue = Promise.resolve();
let generation = 0;
let stopped = false;

/** A new browser stack allows lazy captures again after the previous one shut down. */
export function startMarkingHost() { stopped = false; }

/** Detached contents never enter window enumeration, focus or window-all-closed. */
export async function disposeMarkingHost() {
  stopped = true;
  generation++;
  const previous = host;
  host = ready = undefined;
  if (previous && !previous.contents.isDestroyed()) {
    await new Promise(resolve => {
      previous.contents.once("destroyed", resolve);
      previous.contents.close({ waitForBeforeUnload: false });
    });
  }
}
app.on("will-quit", () => { void disposeMarkingHost(); });

async function markingHost() {
  const current = host;
  if (current && !current.contents.isDestroyed()) { await ready; return current.contents; }
  const view = new WebContentsView({ webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false,
    offscreen: true, backgroundThrottling: false,
  } });
  const contents = view.webContents;
  const entry = { view, contents };
  host = entry;
  const reset = () => {
    if (host === entry) { host = ready = undefined; }
    if (!contents.isDestroyed()) contents.close();
  };
  contents.once("render-process-gone", reset);
  contents.once("destroyed", reset);
  ready = whileAlive(contents, () => contents.loadURL("data:text/html,<meta charset=utf-8>"));
  try { await ready; } catch (error) { reset(); throw error; }
  return contents;
}

/** Electron can leave executeJavaScript pending forever when its renderer dies. */
function whileAlive(contents, run) {
  return new Promise((resolve, reject) => {
    const finish = (error, value) => {
      contents.removeListener("destroyed", gone);
      contents.removeListener("render-process-gone", gone);
      if (error) reject(error); else resolve(value);
    };
    const gone = () => finish(new Error("Marking renderer unavailable"));
    if (contents.isDestroyed()) { gone(); return; }
    contents.once("destroyed", gone);
    contents.once("render-process-gone", gone);
    Promise.resolve().then(run).then(value => finish(null, value), error => finish(error));
  });
}

/** All geometry and label eligibility are decided in original bitmap coordinates. */
function paintScript(image, marks, original) {
  const size = image.getSize();
  return `(() => {
    const width=${size.width},height=${size.height};
    const bytes=Uint8ClampedArray.from(atob(${JSON.stringify(bitmapRgba(image).toString("base64"))}),c=>c.charCodeAt(0));
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const context=canvas.getContext('2d');context.putImageData(new ImageData(bytes,width,height),0,0);
    context.scale(width/${original.width},height/${original.height});
    const labelScale=${Math.max(1, Math.max(original.width, original.height) / 1024)};
    context.font=(12*labelScale)+'px monospace';
    for(const mark of ${JSON.stringify(marks)}) {
      const {x,y,width,height}=mark.rect;
      if(mark.secure){context.fillStyle='#000';context.fillRect(x,y,width,height);continue;}
      context.strokeStyle='#222';context.lineWidth=2*labelScale;context.strokeRect(x,y,width,height);
      const w=context.measureText(mark.ref).width+6*labelScale,h=16*labelScale,top=Math.max(0,y-h);
      if(width<w || height<h)continue;
      context.fillStyle='#fff';context.fillRect(x,top,w,h);context.fillStyle='#000';context.fillText(mark.ref,x+3*labelScale,top+12*labelScale);
    }
    return context.getImageData(0,0,canvas.width,canvas.height).data;
  })()`;
}

/** A failed or disposed render cannot poison the next capture in the queue. */
export function markedImage(image, marks, original = image.getSize()) {
  if (stopped) return Promise.reject(new Error("Marking host disposed"));
  const requested = generation;
  const render = async () => {
    if (requested !== generation) throw new Error("Marking host disposed");
    const contents = await markingHost();
    if (requested !== generation) throw new Error("Marking host disposed");
    const pixels = await whileAlive(contents, () => contents.executeJavaScript(paintScript(image, marks, original)));
    return imageFromRgba(pixels, image.getSize());
  };
  const result = queue.then(render);
  queue = result.catch(() => {});
  return result;
}
