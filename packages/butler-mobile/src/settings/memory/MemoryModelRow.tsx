import { useState } from "react";
import { getAppCopy } from "../../../../butler-i18n/src/index.ts";
import { useConversation } from "@/conversation/live";
import { Button, ListGroup, ListGroupItem, Text, showToast } from "@/ds";
import { useAppLocale } from "@/i18n";
import { SwitchRow } from "../rows";
import type { SetupReadinessView } from "../types";
import type { useMemoryData } from "./useMemoryData";

export function MemoryModelRow({ data }: { data: ReturnType<typeof useMemoryData> }) {
  const copy = getAppCopy(useAppLocale()).firstRun;
  const { client } = useConversation();
  const [saving, setSaving] = useState(false);
  const model = data.readiness?.memory_model;
  const choose = async (enabled: boolean) => {
    if (!client || saving) return;
    setSaving(true);
    try { data.setReadiness(await client.request<SetupReadinessView>("/setup/memory-model", { method: "POST", body: { enabled } })); }
    catch { showToast({ message: copy.memoryChoice.saveFailed, tone: "error" }); }
    finally { setSaving(false); }
  };
  const retry = async () => {
    if (!client) return;
    try { data.setReadiness(await client.request<SetupReadinessView>("/setup/readiness/retry", { method: "POST", body: { memory_model_only: true } })); }
    catch { data.setReadiness(null); }
  };
  const sizeMB = model && model.bytes_total > 0 && model.state !== "ready" ? Math.round(model.bytes_total / 1_000_000) : undefined;
  const failed = model?.state === "failed";
  const label = failed ? copy.memoryModel.failed : model?.state === "verifying" ? copy.memoryModel.verifying : copy.memoryModel.downloading;
  const percent = model && model.bytes_total > 0 ? Math.floor(model.bytes_done / model.bytes_total * 100) : 0;
  const progress = model ? copy.memoryModel.progress(percent, Math.round(model.bytes_done / 1_000_000), Math.round(model.bytes_total / 1_000_000)) : "";
  return <ListGroup label={copy.memoryModel.label}>
    <SwitchRow title={copy.memoryChoice.on} description={copy.memoryModel.description(sizeMB)} value={Boolean(model && model.state !== "unset" && model.state !== "off")}
      disabled={!model || saving} onChange={enabled => void choose(enabled)} />
    {model?.state === "ready" ? <ListGroupItem><Text variant="caption" tone="success">{copy.memoryModel.ready}</Text></ListGroupItem> : null}
    {model && !["ready", "unset", "off"].includes(model.state) ? <ListGroupItem>
      <Text variant="caption" tone={failed ? "danger" : "secondary"}>{model.state === "downloading" ? `${label} · ${progress}` : label}</Text>
      {failed ? <><Text variant="caption">{copy.memoryModel.reasons[model.reason ?? ""] ?? copy.memoryModel.reasons.default}</Text>
        <Button label={copy.memoryModel.retry} onPress={() => void retry()} /></> : null}
    </ListGroupItem> : null}
  </ListGroup>;
}
