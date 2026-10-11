import { create } from "zustand";
import { api } from "@/app/api";
import { useButlerStore } from "@/app/store";
import { browserCall } from "./browserBridge";
export interface HistoryVisit {
  id: number; url: string; title: string; favicon: string; visitTime: number; visitedAt: string;
  transition: string; tabKind: "mine" | "conversation"; conversationId?: string; butlerDriven: boolean; source: string;
}
export interface HistoryPageData { items: HistoryVisit[]; next_cursor?: string | null }
export interface AddressSuggestion { url: string; title: string; favicon: string; bookmarkId?: string; visits: number; lastVisit: number; score: number }
export const useHistoryVersion = create(() => ({ version: 0 }));
export const historyChanged = () => useHistoryVersion.setState(s => ({ version: s.version + 1 }));
export function openHistory(from: "browser" | "settings" = "browser") { useButlerStore.getState().setView({ kind: "history", from }); }
export async function historyCommand(command: string, body: unknown) {
  const result = await api(`/browser-history/${command}`, { method: "POST", body: JSON.stringify(body) }); historyChanged(); return result;
}
export async function openHistoryUrl(url: string) {
  await browserCall("open"); await browserCall("create", { url }); useButlerStore.getState().setView({ kind: "browser" });
}
