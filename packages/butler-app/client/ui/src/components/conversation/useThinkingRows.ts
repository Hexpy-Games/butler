import { useEffect } from "react";
import type { ProgressRow } from "@/app/types";
import { useButlerStore } from "@/app/store";
import { useModelThinking } from "@/app/modelThinking";
import { appCopy } from "@/app/copy";

/** Overlay ephemeral summaries on their round's existing lifecycle position. */
export function useThinkingRows(rows: ProgressRow[], turnId?: string): ProgressRow[] {
  const enabled = useButlerStore(state => state.settings.show_thinking);
  const summaries = useModelThinking(state => turnId ? state.summaries[turnId] : undefined);
  useEffect(() => {
    if (!summaries || !turnId) return;
    const pending = enabled ? summaries.filter(summary => !rows.some(row => row.tool_call_id === summary.round && row.tool_result_id && row.thinking_title)) : [];
    if (pending.length === summaries.length) return;
    useModelThinking.setState(state => {
      const next = { ...state.summaries };
      if (pending.length) next[turnId] = pending; else delete next[turnId];
      return { summaries: next };
    });
  }, [enabled, rows, summaries, turnId]);
  if (!enabled) return rows.filter(row => !row.thinking_title);
  const durable = new Set(rows.filter(row => row.tool_result_id && row.thinking_title).map(row => row.tool_call_id));
  const live = (summaries ?? []).filter(summary => !durable.has(summary.round));
  const overlaid = rows.map(row => {
    const summary = live.find(item => item.round === row.tool_call_id);
    return summary ? { ...row, thinking_title: summary.title || appCopy.interfaceStatus.thinking, thinking_body: summary.text } : row;
  });
  for (const summary of live) {
    if (rows.some(row => row.tool_call_id === summary.round)) continue;
    overlaid.push({ id: `thinking:${summary.round}`, tool_call_id: summary.round, turn_id: turnId,
      kind: "message", bridge_phase: "model_round_waiting", state: "running", safe_label: "",
      thinking_title: summary.title || appCopy.interfaceStatus.thinking, thinking_body: summary.text });
  }
  return overlaid;
}
