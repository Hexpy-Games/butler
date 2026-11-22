import { useEffect, useState } from "react";
import { Platform } from "react-native";
import { File, Paths } from "expo-file-system";
import { GatewayError } from "../../../butler-protocol/src/client/index.ts";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { useConversation } from "@/conversation/live";
import { useAppLocale, useMobileCopy } from "@/i18n";
import { fileSource, readFileText } from "./fileAccess";
import { fileViewMode, type ResultTarget } from "./results";
import { loadPdfjs } from "./pdfjsAssets";
import { pdfPage } from "./pdfPage";

type ViewerContent =
  | { status: "loading" }
  | { status: "failed"; message: string }
  | { status: "markdown" | "text"; text: string }
  | { status: "web"; source: { uri: string; headers?: Record<string, string> } }
  | { status: "html"; html: string }
  | { status: "unsupported" };

export function useViewerContent(target: Exclude<ResultTarget, { kind: "image" }>, background: string) {
  const { pairing, client } = useConversation();
  const app = getAppCopy(useAppLocale()), M = useMobileCopy();
  const [content, setContent] = useState<ViewerContent>({ status: "loading" });
  const { kind, title } = target;
  const id = target.kind === "url" ? target.url : target.id;
  const name = target.kind === "file" ? target.name : undefined;
  const type = target.kind === "file" ? target.type : undefined;
  useEffect(() => {
    let closed = false;
    setContent({ status: "loading" });
    const load = async (): Promise<ViewerContent> => {
      if (kind === "url") return { status: "web", source: { uri: id } };
      if (kind === "doc") {
        const { body } = await client!.request<{ body: string }>(`/documents/${encodeURIComponent(id)}`);
        return { status: "markdown", text: body };
      }
      if (kind === "output") {
        const { url } = await client!.request<{ url: string }>(`/outputs/${encodeURIComponent(id)}/view`);
        return { status: "web", source: { uri: url } };
      }
      const mode = fileViewMode(name!, type), path = `/message-files/${encodeURIComponent(id)}`;
      if (mode === "markdown" || mode === "text") return { status: mode, text: await readFileText(pairing!, path) };
      if (mode === "image") return { status: "web", source: fileSource(pairing!, path) };
      if (mode === "pdf") {
        const s = fileSource(pairing!, path);
        if (Platform.OS === "ios") return { status: "web", source: s };
        const file = await File.downloadFileAsync(s.uri, new File(Paths.cache, name!), { headers: s.headers, idempotent: true });
        let data: string;
        try { data = await file.base64(); } finally { file.delete(); }
        return { status: "html", html: pdfPage({ ...(await loadPdfjs()), data, background }) };
      }
      if (mode === "html") {
        const { url } = await client!.request<{ url: string }>(`${path}/view`);
        return { status: "web", source: { uri: url } };
      }
      return { status: "unsupported" };
    };
    void load().then(value => { if (!closed) setContent(value); }).catch(error => {
      if (!closed) setContent({ status: "failed", message: error instanceof GatewayError && error.code === "content_host_required"
        ? app.artifacts.contentHostRequired : M.outputs.loadFailed });
    });
    return () => { closed = true; };
  }, [kind, id, title, name, type, client, pairing, background, app.artifacts.contentHostRequired, M.outputs.loadFailed]);
  return { content, setFailed: () => setContent({ status: "failed", message: M.outputs.loadFailed }) };
}
