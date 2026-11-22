import { Image } from "react-native";
import { fetch as expoFetch } from "expo/fetch";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { openImageViewer } from "@/conversation/imageViewer";

type Pairing = { origin: string; deviceToken: string };

export function fileSource(pairing: Pairing, path: string): { uri: string; headers: Record<string, string> } {
  const url = new URL(path, pairing.origin);
  return { uri: url.href, headers: url.origin === new URL(pairing.origin).origin ? { Authorization: `Bearer ${pairing.deviceToken}` } : {} };
}

export async function readFileText(pairing: Pairing, path: string): Promise<string> {
  const s = fileSource(pairing, path);
  const response = await expoFetch(s.uri, { headers: s.headers });
  if (!response.ok) throw new Error(`http_${response.status}`);
  return response.text();
}

export async function openImage(pairing: Pairing, path: string, title: string): Promise<void> {
  const s = fileSource(pairing, path);
  const { width, height } = await Image.getSizeWithHeaders(s.uri, s.headers);
  openImageViewer([{ source: s, alt: title, width, height }], 0);
}

export async function shareFile(pairing: Pairing, path: string, name: string, title: string): Promise<void> {
  const s = fileSource(pairing, path);
  const file = await File.downloadFileAsync(s.uri, new File(Paths.cache, name.split("/").pop() || name), { headers: s.headers, idempotent: true });
  try { await Sharing.shareAsync(file.uri, { dialogTitle: title }); } finally { file.delete(); }
}

export async function shareText(name: string, text: string, title: string): Promise<void> {
  const file = new File(Paths.cache, name);
  file.write(text);
  try { await Sharing.shareAsync(file.uri, { dialogTitle: title }); } finally { file.delete(); }
}
