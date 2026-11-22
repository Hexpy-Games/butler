// Bundled pdf.js (Android only; Metro platform resolution keeps it out of iOS). metro.pdfjs-transformer.js turns these files into strings.
export function loadPdfjs(): Promise<{ lib: string; worker: string }> {
  return Promise.resolve({ lib: require("pdfjs-dist/legacy/build/pdf.min.mjs"), worker: require("pdfjs-dist/legacy/build/pdf.worker.min.mjs") });
}
