import { api } from "./api";

export interface PublishedPage {
  id: string;
  url: string;
  title: string;
  status: "live" | "pending" | "taken_down";
  size_bytes: number;
  file_count: number;
  updated_at: string;
  item_id: string | null;
}

export interface PublishedPages {
  pages: PublishedPage[];
  used: number;
  limit: number;
  badge: boolean;
  page_bytes: number;
  page_files: number;
}

const itemPath = (id: string) => `/library/${encodeURIComponent(id)}/publish`;
export const getPublishing = () => api<{ signed_in: boolean }>("/publishing");
export const previewPublish = (id: string) => api<{ signed_in: true; file_count: number; size_bytes: number }>(itemPath(id));
export const publishItem = (id: string) =>
  api<{ page_id: string; url: string; version: number; file_count: number; size_bytes: number }>(itemPath(id), { method: "POST" });
export const unpublishItem = (id: string) => api<{ unpublished: true }>(itemPath(id), { method: "DELETE" });
export const listPublishedPages = () => api<PublishedPages>("/publishing/pages");
export const unpublishPage = (page: PublishedPage) => page.item_id
  ? unpublishItem(page.item_id)
  : api<{ unpublished: true }>(`/publishing/pages/${encodeURIComponent(page.id)}`, { method: "DELETE" });
