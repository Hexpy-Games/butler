// Test-only pixel consumer; no product preload or persisted state.
const { ipcRenderer } = require("electron");
ipcRenderer.on("spike:frame", async (_event, frame) => {
  const bitmap = await createImageBitmap(new Blob([frame.bytes], { type: "image/jpeg" }));
  let canvas = document.getElementById(frame.tab);
  if (!canvas) {
    canvas = document.createElement("canvas"); canvas.id = frame.tab;
    canvas.width = 416; canvas.height = 260; document.body.append(canvas);
  }
  if (bitmap.width !== 416 || bitmap.height !== 260) throw new Error("Incomplete frame geometry");
  const ctx = canvas.getContext("2d"); ctx.drawImage(bitmap, 0, 0); bitmap.close();
  let paintAt = 0;
  for (let bit = 0; bit < 42; bit++) {
    const pixel = ctx.getImageData(Math.round((bit * 30 + 15) * 416 / 1280), Math.round(115 * 260 / 800), 1, 1).data;
    if (pixel[0] > 128) paintAt += 2 ** bit;
  }
  ipcRenderer.send("spike:drawn", { tab: frame.tab, generation: frame.generation, latency: Date.now() - paintAt });
});
