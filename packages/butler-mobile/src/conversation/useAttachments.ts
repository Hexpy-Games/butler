import { useState } from "react";
import * as ImagePicker from "expo-image-picker";
import * as DocumentPicker from "expo-document-picker";
import type { MessageFileRef } from "../../../butler-protocol/src/index.ts";
import { showToast } from "@/ds";
import { useMobileCopy } from "@/i18n";
import { useConversation } from "./live";
import { uploadMessageFile } from "./upload";

type Attachment = {
  key: string; name: string; kind: "image" | "file"; uri: string; mimeType: string; size?: number;
  status: "uploading" | "ready" | "failed"; file?: MessageFileRef;
};

export function useAttachments(sessionId: string) {
  const { pairing } = useConversation();
  const copy = useMobileCopy();
  const [items, setItems] = useState<Attachment[]>([]);
  const remove = (key: string) => setItems(previous => previous.filter(item => item.key !== key));
  const removeMany = (keys: string[]) => setItems(previous => previous.filter(item => !keys.includes(item.key)));
  const upload = async (file: { uri: string; name: string; mimeType: string; kind: "image" | "file"; size?: number }) => {
    if (!pairing) return;
    const key = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    setItems(previous => [...previous, { key, ...file, status: "uploading" }]);
    try {
      const uploaded = await uploadMessageFile({ origin: pairing.origin, token: pairing.deviceToken, sessionId, file });
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
  return { items, pick, remove, removeMany };
}
