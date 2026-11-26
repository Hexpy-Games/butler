import { useState } from "react";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import { File, Paths } from "expo-file-system";
import { isProjectSourceContentPart, type MessageFileRef, type ProjectDashboardDocument, type ProjectSourceContentPart } from "../../../butler-protocol/src/index.ts";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { showToast } from "@/ds";
import { useAppLocale, useMobileCopy } from "@/i18n";
import { useConversation } from "./live";
import { uploadMessageFile } from "./upload";
import { ATTACHMENT_MAX_BYTES, completeProjectDocument, projectDocumentFileName, readProjectDocumentPage } from "./documents";

type Attachment = {
  key: string; name: string; kind: "image" | "file"; uri?: string; mimeType?: string; size?: number;
  status: "uploading" | "ready" | "failed"; file?: MessageFileRef; reference?: ProjectSourceContentPart;
};

export function useAttachments(sessionId: string | undefined) {
  const { pairing, client, route } = useConversation();
  const copy = useMobileCopy();
  const appCopy = getAppCopy(useAppLocale());
  const [items, setItems] = useState<Attachment[]>([]);
  const remove = (key: string) => setItems(previous => previous.filter(item => item.key !== key));
  const removeMany = (keys: string[]) => setItems(previous => previous.filter(item => !keys.includes(item.key)));
  const upload = async (file: { uri: string; name: string; mimeType: string; kind: "image" | "file"; size?: number }) => {
    if (!pairing || !route) return;
    const key = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    setItems(previous => [...previous, { key, ...file, status: "uploading" }]);
    try {
      const uploaded = await uploadMessageFile({ route, token: pairing.deviceToken, sessionId, file });
      setItems(previous => previous.map(item => item.key === key ? { ...item, status: "ready", file: uploaded } : item));
    } catch {
      setItems(previous => previous.map(item => item.key === key ? { ...item, status: "failed" } : item));
      showToast({ message: copy.chat.uploadFailed, tone: "error" });
    }
  };
  const pick = async (kind: "photo" | "file") => {
    try {
      if (kind === "photo") {
        const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsMultipleSelection: true, quality: 0.9 });
        if (!result.canceled) for (const asset of result.assets) void upload({
          uri: asset.uri, name: asset.fileName ?? asset.uri.split("/").at(-1) ?? copy.chat.attachPhoto,
          mimeType: asset.mimeType ?? "application/octet-stream", kind: "image", size: asset.fileSize,
        });
      } else {
        const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
        if (!result.canceled) for (const asset of result.assets) void upload({
          uri: asset.uri, name: asset.name, mimeType: asset.mimeType ?? "application/octet-stream",
          kind: asset.mimeType?.startsWith("image/") ? "image" : "file", size: asset.size,
        });
      }
    } catch { showToast({ message: copy.chat.uploadFailed, tone: "error" }); }
  };
  const addProjectDocument = async (document: ProjectDashboardDocument) => {
    if (!client || !pairing || !route) return;
    const sources = new Set(items.flatMap(item => item.reference ? [`${item.reference.source.kind}:${item.reference.source.id}`] : []));
    if (document.project_id && document.revision && sources.size >= 8 && !sources.has(`${document.document_type ?? document.kind}:${document.id}`)) {
      showToast({ message: appCopy.feedback.attachmentFailed, tone: "error" });
      return;
    }
    const key = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    setItems(previous => [...previous, { key, name: document.title, kind: "file", status: "uploading" }]);
    try {
      if (document.project_id && document.revision) {
        const source = await readProjectDocumentPage(client, document);
        const reference = { type: "project_source_ref", projectId: document.project_id, titleSnapshot: source.title,
          source: { kind: source.document_type ?? source.kind, id: source.id, revision: source.revision } };
        if (!isProjectSourceContentPart(reference)) throw new Error("Invalid project source.");
        setItems(previous => previous.map(item => item.key === key ? { ...item, name: reference.titleSnapshot, status: "ready", reference } : item));
      } else {
        const complete = await completeProjectDocument(client, document);
        const name = projectDocumentFileName(document);
        const cached = new File(Paths.cache, `${key}-${name}`);
        try {
          cached.write(complete.markdown);
          if (cached.size > ATTACHMENT_MAX_BYTES) throw new Error("Project source exceeds the attachment limit.");
          const file = await uploadMessageFile({ route, token: pairing.deviceToken, sessionId,
            file: { uri: cached.uri, name, mimeType: "text/markdown" } });
          setItems(previous => previous.map(item => item.key === key ? { ...item, name, status: "ready", file } : item));
        } finally { if (cached.exists) cached.delete(); }
      }
    } catch {
      setItems(previous => previous.map(item => item.key === key ? { ...item, status: "failed" } : item));
      showToast({ message: appCopy.feedback.attachmentFailed, tone: "error" });
    }
  };
  return { items, pick, addProjectDocument, remove, removeMany };
}
