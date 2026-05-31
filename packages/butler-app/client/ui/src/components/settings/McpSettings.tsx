import { useEffect, useState } from "react";
import { api } from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import type {
  McpCapabilitiesView,
  McpServerListView,
  McpServerMutationResult,
  McpServerView,
} from "@/app/types.ts";
import { Button, CardList, Stack, Typo } from "@/butler-ds";
import { SettingsSection } from "./SettingsFormComponents";
import { McpServerForm } from "./McpServerForm";
import { McpServerRow } from "./McpServerRow";
import {
  emptyMcpServerForm,
  formFromMcpServer,
  mcpServerPayload,
  type McpServerFormState,
} from "./mcpSettingsUtils";

export function McpSettings() {
  const copy = appCopy.settings;
  const [servers, setServers] = useState<McpServerView[]>([]);
  const [form, setForm] = useState<McpServerFormState>(emptyMcpServerForm);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("");
  const [open, setOpen] = useState(false);
  useEffect(() => {
    void refresh();
  }, []);
  async function refresh() {
    const result = await api<McpServerListView>("/mcp-servers");
    setServers(result.servers);
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
    <SettingsSection
      title={copy.panels.mcpServers}
      description={copy.descriptions.mcpServers}
    >
      <Stack gap="md">
        <Stack align="row" justify="between" cross="center">
          <Typo.Caption>{status}</Typo.Caption>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setEditingId(null);
              setForm(emptyMcpServerForm());
              setOpen(true);
            }}
          >
            {copy.actions.addMcpServer}
          </Button>
        </Stack>
        <CardList
          empty={<Typo.Caption>등록된 MCP 서버가 없습니다.</Typo.Caption>}
        >
          {servers.map((server) => (
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
        {open && (
          <McpServerForm
            form={form}
            onChange={update}
            onCancel={() => setOpen(false)}
            onSave={() => void save()}
          />
        )}
      </Stack>
    </SettingsSection>
  );
}
