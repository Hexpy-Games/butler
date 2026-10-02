import { useAppLocale } from "@/app/copy.ts";
import { useEffect, useState } from "react";
import { api } from "@/app/api.ts";
import { appCopy } from "@/app/copy.ts";
import type {
  McpServerListView,
  McpServerView,
} from "@/app/types.ts";
import { Button, CardList, Plus, Typo } from "@/butler-ds";
import { SettingsPage, SettingsSection } from "./SettingsFormComponents";
import { useMcpSettingsActions } from "./useMcpSettingsActions";
import { McpServerForm } from "./McpServerForm";
import { McpServerRow } from "./McpServerRow";
import {
  emptyMcpServerForm,
  formFromMcpServer,
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
  const { save, remove, toggle, probe, busy } = useMcpSettingsActions({
    form, editingId, setServers, setStatus,
    onSaved: () => {
      setOpen(false);
      setEditingId(null);
      setForm(emptyMcpServerForm());
    },
  });
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
            disabled={busy}
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
              busy={busy}
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
            busy={busy}
            onChange={update}
            onCancel={() => setOpen(false)}
            onSave={() => void save()}
          />
        </SettingsSection>
      ) : null}
    </SettingsPage>
  );
}
