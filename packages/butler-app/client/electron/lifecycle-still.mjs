import { app, ipcMain } from "electron";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function installLifecycleStillBridge(renderer) {
  const directory = join(app.getPath("userData"), "lifecycle");
  let records;
  let writes = Promise.resolve();
  ipcMain.handle("butler:lifecycle-still", (event, input) => {
    if (event.sender !== renderer()?.webContents || event.senderFrame !== event.sender.mainFrame) return false;
    if (!input || !["light", "dark"].includes(input.tone) || typeof input.sourceKey !== "string" || input.sourceKey.length > 16_384 ||
        !/^#[\da-f]{6}$/i.test(input.averageColor) || !Array.isArray(input.bytes) || input.bytes.length > 81_920 ||
        !input.bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) return false;
    const save = async () => {
      records ??= await readFile(join(directory, "still.json"), "utf8").then(JSON.parse).catch(() => ({}));
      if (records[input.tone]?.sourceKey === input.sourceKey) return true;
      await mkdir(directory, { recursive: true });
      const file = join(directory, `still-${input.tone}.webp`);
      await writeFile(`${file}.tmp`, Buffer.from(input.bytes), { mode: 0o600 });
      await rename(`${file}.tmp`, file);
      const next = { ...records, [input.tone]: { sourceKey: input.sourceKey, tone: input.tone, averageColor: input.averageColor, rendered_at: new Date().toISOString() } };
      await writeFile(join(directory, "still.json.tmp"), JSON.stringify(next), { mode: 0o600 });
      await rename(join(directory, "still.json.tmp"), join(directory, "still.json"));
      records = next;
      return true;
    };
    const result = writes.then(save);
    writes = result.catch(() => undefined);
    return result;
  });
}
