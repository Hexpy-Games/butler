import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createPortal } from "react-dom";
import { Download, IconButton, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, Typo } from "@/butler-ds";
import { appCopy } from "@/app/copy";
import { gatewayImageSource } from "@/app/messageFileUrls";
import { notifyStatus } from "@/app/notifications";
import { DocumentReadView } from "./DocumentReadView";
import { documentFileName, exportDocumentMarkdown } from "./documentExport";
import type { EditableDocument } from "./documentApi";
async function imageData(doc: EditableDocument, id: string) {
  const asset = doc.assets?.find(asset => asset.id === id);
  const url = gatewayImageSource(asset?.signed_url ?? asset?.url);
  if (!url) throw new Error("Image is unavailable.");
  const response = await fetch(url); if (!response.ok) throw new Error("Image is unavailable.");
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject;
    void response.blob().then(blob => reader.readAsDataURL(blob), reject);
  });
}
async function documentStyles() {
  const sheets = await Promise.all([...document.querySelectorAll<HTMLStyleElement | HTMLLinkElement>('style,link[rel="stylesheet"]')].map(async element => {
    if (element instanceof HTMLStyleElement) return element.textContent ?? "";
    const response = await fetch(element.href); if (!response.ok) throw new Error("Styles are unavailable.");
    return response.text();
  }));
  return sheets.join("\n");
}
function download(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function useDocumentExport(prepare: () => Promise<EditableDocument>) {
  const ref = useRef<HTMLDivElement>(null), [printDoc, setPrintDoc] = useState<EditableDocument>();
  const run = async (format: "markdown" | "pdf") => {
    const doc = await prepare();
    const name = `${documentFileName(doc.title)}.${format === "markdown" ? "md" : "pdf"}`;
    let content: string;
    const data = new Map<string, string>();
    const read = (id: string) => data.has(id) ? Promise.resolve(data.get(id)!) : imageData(doc, id).then(value => { data.set(id, value); return value; });
    if (format === "markdown") content = await exportDocumentMarkdown(doc.body, read);
    else {
      const assets = await Promise.all((doc.assets ?? []).map(async asset => ({ ...asset, signed_url: await read(asset.id) })));
      flushSync(() => setPrintDoc({ ...doc, assets }));
      content = `<!doctype html><html lang="${document.documentElement.lang}"><head><meta charset="utf-8"><style>${await documentStyles()}</style></head><body class="${document.body.className}">${ref.current!.innerHTML}</body></html>`;
      setPrintDoc(undefined);
    }
    if (window.butlerApp?.exportDocument) await window.butlerApp.exportDocument({ format, name, content });
    else if (format === "markdown") download(name, content);
    else {
      const frame = document.createElement("iframe"); frame.hidden = true; document.body.append(frame);
      frame.contentDocument!.open(); frame.contentDocument!.write(content); frame.contentDocument!.close();
      await Promise.all([...frame.contentDocument!.images].map(image => image.decode().catch(() => undefined)));
      await frame.contentDocument!.fonts.ready;
      frame.contentWindow!.addEventListener("afterprint", () => frame.remove(), { once: true }); frame.contentWindow!.print();
    }
  };
  const start = (format: "markdown" | "pdf") => { void run(format).catch(() => notifyStatus(appCopy.library.failed, { tone: "error" })); };
  const portal = printDoc ? createPortal(<div hidden aria-hidden="true"><div ref={ref}><Typo.H1>{printDoc.title}</Typo.H1><DocumentReadView doc={printDoc} print /></div></div>, document.body) : null;
  return { start, portal };
}
export function DocumentExportMenu({ start }: { start: (format: "markdown" | "pdf") => void }) {
  const copy = appCopy.documents;
  return <DropdownMenu><DropdownMenuTrigger asChild><IconButton label={copy.export}><Download size="sm" /></IconButton></DropdownMenuTrigger>
    <DropdownMenuContent align="end"><DropdownMenuItem onSelect={() => start("markdown")}>{copy.markdown}</DropdownMenuItem><DropdownMenuItem onSelect={() => start("pdf")}>{copy.pdf}</DropdownMenuItem></DropdownMenuContent>
  </DropdownMenu>;
}
