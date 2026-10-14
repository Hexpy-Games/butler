import { clipboard, dialog } from "electron";
import { writeFile } from "node:fs/promises";

function completed(browser, op, elements) {
  browser.getWindow()?.webContents.send("butler-browser:selection-action", { op, elements });
}
export function copyPickedText(browser, tab) {
  const elements = [...(tab.selections ?? [])];
  if (!elements.length) return;
  clipboard.writeText(elements.map(element => element.text ?? "").join("\n\n"));
  completed(browser, "copy-text", elements);
}
export async function savePickedImages(browser, tab) {
  const elements = [...(tab.selections ?? [])];
  if (!elements.length) return;
  const release = browser.nativeCover();
  try {
    const saved = [];
    for (const [index, element] of elements.entries()) {
      if (!/^data:image\/jpeg;base64,/u.test(element.crop ?? "")) throw new Error("invalid_pick_crop");
      const result = await dialog.showSaveDialog(browser.getWindow(), {
        defaultPath: `selection-${index + 1}.jpg`, filters: [{ name: "JPEG", extensions: ["jpg"] }],
      });
      if (result.canceled || !result.filePath) break;
      await writeFile(result.filePath, Buffer.from(element.crop.split(",")[1], "base64"));
      saved.push(element);
    }
    if (saved.length) completed(browser, "save-image", saved);
  } finally { release(); }
}
