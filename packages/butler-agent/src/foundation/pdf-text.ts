/** PDF bytes only: no attachment storage or upload policy. */
export async function extractPdfText(bytes: Uint8Array): Promise<{ text: string; title?: string }> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes, { verbosity: 0 });
  try {
    const result = await extractText(pdf, { mergePages: false });
    const text = result.text.map((page) => page.trim()).join("\n\n---\n\n").trim();
    if (!result.text.some((page) => page.trim())) {
      throw new Error("PDF text is unavailable. This may be a scanned document; OCR and page images have not been read.");
    }
    const metadata = await pdf.getMetadata().catch(() => null);
    const title = metadata?.info && "Title" in metadata.info && typeof metadata.info.Title === "string"
      ? metadata.info.Title.trim() || undefined
      : undefined;
    return { text, title };
  } finally {
    await pdf.loadingTask.destroy();
  }
}
