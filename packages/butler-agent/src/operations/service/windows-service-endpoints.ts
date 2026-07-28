import { createHash } from "crypto";
import { win32 } from "path";

export function windowsEmbedPipe(butlerData: string): string {
  const dataScope = createHash("sha256")
    .update(win32.normalize(butlerData).toLocaleLowerCase("en-US"))
    .digest("hex")
    .slice(0, 16);
  return `\\\\.\\pipe\\butler-embed-${dataScope}`;
}
