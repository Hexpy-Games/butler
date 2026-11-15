/** Native PDF export uses the Electron print renderer, including every printable block. */
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { Typo } from "@/butler-ds";
import "@/butler-ds/tokens.css";
import { DocumentReadView } from "./DocumentReadView";
import type { EditableDocument } from "./documentApi";

const encoded = document.getElementById("document-input")!.textContent!;
const doc = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded), char => char.charCodeAt(0)))) as EditableDocument;
const hidden = document.createElement("div"), host = document.createElement("div");
hidden.hidden = true; hidden.append(host); document.body.replaceChildren(hidden);
const root = createRoot(host);
flushSync(() => root.render(<><Typo.H1>{doc.title}</Typo.H1><DocumentReadView doc={doc} print /></>));
const html = host.innerHTML;
flushSync(() => root.unmount());
document.body.innerHTML = html;
document.documentElement.dataset.exportReady = "true";
