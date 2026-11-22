export function loadPdfjs(): Promise<{ lib: string; worker: string }> { return Promise.reject(new Error("pdfjs_unavailable")); }
