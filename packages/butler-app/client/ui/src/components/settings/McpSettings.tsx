import { useAppLocale } from "@/app/copy.ts";
import { useEffect, useState } from "react";
import { api } from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import type {
  McpCapabilitiesView,
  McpServerListView,
  McpServerMutationResult,
  McpServerView,
} from "@/app/types.ts";
import { Button, CardList, Plus, Typo } from "@/butler-ds";
import { SettingsPage, SettingsSection } from "./SettingsFormComponents";
import { McpServerForm } from "./McpServerForm";
import { McpServerRow } from "./McpServerRow";
import {
  emptyMcpServerForm,
  formFromMcpServer,
  mcpServerPayload,
  type McpServerFormState,
} from "./mcpSettingsUtils";

export function McpSettings() {
  useAppLocale();
  const copy = appCopy.settings;
  const [servers, setServers] = useState<McpServerView[] | null>(null);
  const [form, setForm] = useState<McpServerFormState>(emptyMcpServerForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("");
  const [open, setOpen] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  useEffect(() => {
    void refresh();
  }, []);
  async function refresh() {
    setLoadFailed(false);
    try {
      const result = await api<McpServerListView>("/mcp-servers");
      setServers(result.servers);
    } catch {
      setLoadFailed(true);
    }
  }
  function update(patch: Partial<McpServerFormState>) {
    setForm((current) => ({ ...current, ...patch }));
  }
  async function save() {
    const includeSecrets = {
      env: !editingId || form.envDirty,
      headers: !editingId || form.headersDirty,
    };
    const path = editingId
      ? `/mcp-servers/${encodeURIComponent(editingId)}`
      : "/mcp-servers";
    const method = editingId ? "PATCH" : "POST";
    const result = await api<McpServerMutationResult>(path, {
      method,
      body: JSON.stringify(mcpServerPayload(form, includeSecrets)),
    });
    setStatus(`${copy.saved}: ${result.server.id}`);
    setOpen(false);
    setEditingId(null);
    setForm(emptyMcpServerForm());
    await refresh();
  }
  async function remove(server: McpServerView) {
    await api(`/mcp-servers/${encodeURIComponent(server.id)}`, {
      method: "DELETE",
    });
    setStatus(`${appCopy.common.delete}: ${server.id}`);
    await refresh();
  }
  async function toggle(server: McpServerView) {
    await api(`/mcp-servers/${encodeURIComponent(server.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: !server.enabled }),
    });
    await refresh();
  }
  async function probe(server: McpServerView) {
    const result = await api<McpCapabilitiesView>(
      `/mcp-servers/${encodeURIComponent(server.id)}/probe`,
      { method: "POST", body: JSON.stringify({}) },
    );
    const item = result.servers[0];
    setStatus(
      item?.ok
        ? `${server.id}: tools ${item.tools.length}, resources ${item.resources.length}`
        : `${server.id}: ${item?.error ?? "probe failed"}`,
    );
  }
  function edit(server: McpServerView) {
    setEditingId(server.id);
    setForm(formFromMcpServer(server));
    setOpen(true);
  }
  return (
    <SettingsPage>
      <SettingsSection
        id="mcp-servers"
        kind="list"
        description={status || undefined}
        state={servers === null ? (loadFailed ? "error" : "loading") : servers.length === 0 ? "empty" : "ready"}
        emptyMessage={appCopy.interfaceDetails.noMcp}
        onRetry={() => void refresh()}
        actions={
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setEditingId(null);
              setForm(emptyMcpServerForm());
              setOpen(true);
            }}
          >
            <Plus size="md" /> {copy.actions.addMcpServer}
          </Button>
        }
      >
        <CardList empty={<Typo.Caption>{appCopy.interfaceDetails.noMcp}</Typo.Caption>}>
          {(servers ?? []).map((server) => (
            <McpServerRow
              key={server.id}
              server={server}
              onProbe={() => void probe(server)}
              onToggle={() => void toggle(server)}
              onEdit={() => edit(server)}
              onRemove={() => void remove(server)}
            />
          ))}
        </CardList>
      </SettingsSection>
      {open ? (
        <SettingsSection id="mcp-server-form" kind="form" title={editingId ?? copy.actions.addMcpServer}>
          <McpServerForm
            form={form}
            onChange={update}
            onCancel={() => setOpen(false)}
            onSave={() => void save()}
          />
        </SettingsSection>
      ) : null}
    </SettingsPage>
  );
}
