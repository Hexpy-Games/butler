import { readFile, writeFile } from "node:fs/promises";

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
    const { extractText } = await import("unpdf");
    const result = await extractText(new Uint8Array(await readFile(originalPath)), {
      mergePages: true,
    });
    text = result.text.trim() ||
      "[PDF text could not be extracted. This may be a scanned document; its page images have not been read.]";
  } catch {
    text = "[PDF text could not be extracted. The file may be encrypted or damaged; its contents have not been read.]";
  }
  await writeFile(pdfTextPath(originalPath), text, "utf8");
}
