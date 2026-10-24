import { useEffect, useRef, useState } from "react";
import { api } from "@/app/api";
import type { OperationOutputView, ProgressRow } from "@/app/types";
import { getImageMeta, type ImageAsset } from "./imageApi";

interface OutputImage { schema: "butler.image.v1"; image: string; parent?: string | null }
function outputImages(value: unknown): OutputImage[] {
  if (typeof value === "string") { try { return outputImages(JSON.parse(value)); } catch { return []; } }
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (record.schema === "butler.image.v1" && typeof record.image === "string") return [record as unknown as OutputImage];
  return Object.values(record).flatMap(outputImages);
}
function toolFailed(value: unknown): boolean {
  if (typeof value === "string") { try { return toolFailed(JSON.parse(value)); } catch { return false; } }
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.ok === false || record.status === "error" || Object.values(record).some(toolFailed);
}
async function readOutput(turn: string, call: string, result: string, signal: AbortSignal) {
  let content = "", offset = 0;
  for (;;) {
    const page = await api<OperationOutputView>(`/turns/${encodeURIComponent(turn)}/operations/${encodeURIComponent(call)}/output?${new URLSearchParams({ result_id: result, offset: String(offset) })}`, { signal });
    content += page.content;
    if (page.complete) return content;
    if (page.byte_end <= offset) throw new Error("image_output_incomplete");
    offset = page.byte_end;
  }
}
/** Reads in tool order; unresolved outputs follow turn revisions, successful reads stay retained. */
export function useImageOutputs(turn: string | undefined, rows: ProgressRow[], revision?: string) {
  const key = JSON.stringify([...new Map(rows.filter(row => ["generate_image", "edit_image"].includes(row.safe_tool_name ?? "")
    && row.tool_call_id && row.tool_result_id).map(row => [row.tool_call_id, [row.tool_call_id!, row.tool_result_id!]] as const)).values()]);
  const completed = useRef<string | undefined>(undefined);
  const identity = `${turn ?? ""}:${key}`;
  const [state, setState] = useState<{ key: string; images: ImageAsset[]; loading: boolean; failed: boolean; unavailable: boolean }>({ key: "", images: [], loading: false, failed: false, unavailable: false });
  useEffect(() => {
    if (completed.current === identity) return;
    const controller = new AbortController();
    const calls = JSON.parse(key) as Array<[string, string]>;
    if (!turn || !calls.length) { setState({ key: identity, images: [], loading: false, failed: false, unavailable: false }); return; }
    setState(prior => ({ ...prior, key: identity, loading: true, unavailable: false }));
    void Promise.all(calls.map(async ([call, result]) => {
      const content = await readOutput(turn, call, result, controller.signal);
      return { images: await Promise.all(outputImages(content).map(image => getImageMeta(image.image, controller.signal))), failed: toolFailed(content) };
    })).then(items => { if (!controller.signal.aborted) { completed.current = identity; setState({ key: identity, images: items.flatMap(item => item.images), loading: false, failed: items.some(item => item.failed), unavailable: false }); } },
      () => { if (!controller.signal.aborted) setState({ key: identity, images: [], loading: false, failed: false, unavailable: true }); });
    return () => controller.abort();
  }, [turn, key, identity, revision]);
  return { unavailable: state.unavailable, images: state.key === identity ? state.images : [], loading: state.key !== identity || state.loading,
    failed: state.failed || rows.some(row => row.safe_tool_name === "edit_image" && (row.state === "failed" || Boolean(row.failure_code))) };
}
