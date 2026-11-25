import { Image } from "react-native";
import { fetch as expoFetch } from "expo/fetch";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { openImageViewer } from "@/conversation/imageViewer";

import type { Access } from "@/connection/access";

/** Bytes the gateway serves on its API (message files, assets). Root-relative paths are joined as strings: new URL() would drop the proxy's /<token> prefix. */
export function fileSource(access: Access, path: string): { uri: string; headers: Record<string, string> } {
  if (access.kind === "relay") return path.startsWith("/") && !path.startsWith("//") ? { uri: access.api + path, headers: {} } : { uri: path, headers: {} };
  const url = new URL(path, access.origin);
  return { uri: url.href, headers: url.origin === new URL(access.origin).origin ? { Authorization: `Bearer ${access.token}` } : {} };
}

export async function readFileText(access: Access, path: string): Promise<string> {
  const s = fileSource(access, path);
  const response = await expoFetch(s.uri, { headers: s.headers });
  if (!response.ok) throw new Error(`http_${response.status}`);
  return response.text();
}

export async function openImage(access: Access, path: string, title: string, share?: () => void): Promise<void> {
  const s = fileSource(access, path);
  const { width, height } = await Image.getSizeWithHeaders(s.uri, s.headers);
  openImageViewer([{ source: s, alt: title, width, height, share }], 0);
}

export async function shareFile(access: Access, path: string, name: string, title: string): Promise<void> {
  const s = fileSource(access, path);
  const file = await File.downloadFileAsync(s.uri, new File(Paths.cache, name.split("/").pop() || name), { headers: s.headers, idempotent: true });
  try { await Sharing.shareAsync(file.uri, { dialogTitle: title }); } finally { file.delete(); }
}

export async function shareText(name: string, text: string, title: string): Promise<void> {
  const file = new File(Paths.cache, name);
  file.write(text);
  try { await Sharing.shareAsync(file.uri, { dialogTitle: title }); } finally { file.delete(); }
}
