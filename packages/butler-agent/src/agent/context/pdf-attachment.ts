import { readFile, writeFile } from "node:fs/promises";
import { extractPdfText } from "../../foundation/pdf-text.ts";

export function isPdfAttachment(mimeType?: string, fileName?: string): boolean {
  return mimeType?.split(";")[0]?.trim().toLowerCase() === "application/pdf" ||
    Boolean(fileName?.toLowerCase().endsWith(".pdf"));
}

export function pdfTextPath(originalPath: string): string {
  return `${originalPath}.txt`;
}

/** Extract once at upload, leaving the original download untouched. */
export async function preparePdfAttachment(originalPath: string): Promise<void> {
  let text: string;
  try {
    text = (await extractPdfText(new Uint8Array(await readFile(originalPath)))).text;
  } catch (error) {
    text = error instanceof Error && error.message.includes("scanned document")
      ? `[${error.message}]`
      : "[PDF text could not be extracted. The file may be encrypted or damaged; its contents have not been read.]";
  }
  await writeFile(pdfTextPath(originalPath), text, "utf8");
}
