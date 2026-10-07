import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { api, apiErrorCode } from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import { confirmAction } from "@/app/confirmation.ts";
import { notifyError } from "@/app/notifications.ts";
import type { McpCapabilitiesView, McpServerMutationResult, McpServerView } from "@/app/types.ts";
import { mcpServerIdError, mcpServerPayload, type McpServerFormState } from "./mcpSettingsUtils";

type ActionsInput = {
  form: McpServerFormState;
  editingId: string | null;
  setServers: Dispatch<SetStateAction<McpServerView[] | null>>;
  setStatus: (value: string) => void;
  onSaved: () => void;
};

export type McpFormErrors = Partial<Record<"id" | "command" | "url", string>>;
const ERROR_FIELDS: Record<string, keyof McpFormErrors> = {
  mcp_server_id_required: "id", mcp_server_id_invalid: "id",
  mcp_command_required: "command", mcp_url_required: "url",
};

export function useMcpSettingsActions({ form, editingId, setServers, setStatus, onSaved }: ActionsInput) {
  const [errors, setErrors] = useState<McpFormErrors>({});
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  async function run(action: () => Promise<void>, fallback: string, inline = false) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try { await action(); }
    catch (error) {
      const code = apiErrorCode(error);
      const field = code ? ERROR_FIELDS[code] : undefined;
      if (inline && field) setErrors({ [field]: code });
      else notifyError(error, fallback);
    }
    finally { inFlight.current = false; setBusy(false); }
  }
  function updateServer(server: McpServerView) {
    setServers((current) => {
      const servers = current ?? [];
      const next = servers.some((item) => item.id === server.id)
        ? servers.map((item) => item.id === server.id ? server : item)
        : [...servers, server];
      return next.sort((left, right) => {
        const a = left.display_name.toLowerCase();
        const b = right.display_name.toLowerCase();
        return a < b ? -1 : a > b ? 1
          : left.display_name < right.display_name ? -1 : left.display_name > right.display_name ? 1 : 0;
      });
    });
  }
  async function save() {
    if (mcpServerIdError(form.id)) { document.getElementById("mcp-server-id")?.focus(); return; }
    setErrors({});
    await run(async () => {
      const path = editingId ? `/mcp-servers/${encodeURIComponent(editingId)}` : "/mcp-servers";
      const result = await api<McpServerMutationResult>(path, {
        method: editingId ? "PATCH" : "POST",
        body: JSON.stringify(mcpServerPayload(form, {
          env: !editingId || form.envDirty, headers: !editingId || form.headersDirty,
        })),
      });
      setStatus(`${appCopy.settings.saved}: ${result.server.id}`);
      updateServer(result.server);
      onSaved();
    }, appCopy.settings.mcpErrors.save, true);
  }
  async function remove(server: McpServerView) {
    await run(async () => {
      if (!await confirmAction(appCopy.settings.deleteMcpServer(server.display_name), {
        title: appCopy.common.delete, confirmLabel: appCopy.common.delete, destructive: true,
      })) return;
      await api(`/mcp-servers/${encodeURIComponent(server.id)}`, { method: "DELETE" });
      setStatus(`${appCopy.common.delete}: ${server.id}`);
      setServers((current) => current?.filter((item) => item.id !== server.id) ?? []);
    }, appCopy.settings.mcpErrors.remove);
  }
  async function toggle(server: McpServerView) {
    await run(async () => {
      const result = await api<McpServerMutationResult>(`/mcp-servers/${encodeURIComponent(server.id)}`, {
        method: "PATCH", body: JSON.stringify({ enabled: !server.enabled }),
      });
      updateServer(result.server);
    }, appCopy.settings.mcpErrors.toggle);
  }
  async function probe(server: McpServerView) {
    await run(async () => {
      const result = await api<McpCapabilitiesView>(`/mcp-servers/${encodeURIComponent(server.id)}/probe`, {
        method: "POST", body: JSON.stringify({}),
      });
      const item = result.servers[0];
      if (!item?.ok) throw new Error(item?.error || appCopy.settings.mcpActionFailed);
      setStatus(`${server.id}: tools ${item.tools.length}, resources ${item.resources.length}`);
    }, appCopy.settings.mcpErrors.probe);
  }
  return { save, remove, toggle, probe, busy, errors, clearErrors: () => setErrors({}) };
}
