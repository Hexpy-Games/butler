import { api } from "@/app/api.ts";

export interface Account {
  id: string; fields: Record<string, string>; enabled: boolean; state: string;
}
export interface ConnectorsView {
  revision: number;
  connectors: Array<{ plugin: string; connector: string; accounts: Account[] }>;
}
interface PluginsView { revision: number; plugins: Array<{ id: string }> }
interface Inspection { staging_id: string; digest: string }
interface Check { status: string; revision: number; pending: Inspection }
export interface MailAccountInput {
  address: string; password: string; imap_host: string; smtp_host: string;
  handling: { mode: "batch"; interval_minutes: number } | { mode: "immediate" };
}
export const listConnectors = () => api<ConnectorsView>("/connectors");
export const listPlugins = () => api<PluginsView>("/plugins");
export const listRules = () => api<{ rules: Array<{ id: string; title: string }> }>("/connector-rules");
export const deleteRule = (id: string) => api(`/connector-rules/${id}`, { method: "DELETE" });
export const retryAccount = (id: string, revision: number) =>
  api(`/connectors/mail/mail/accounts/${id}/retry`, { method: "POST", body: JSON.stringify({ revision }) });
export const removeAccount = (id: string, revision: number) =>
  api(`/connectors/mail/mail/accounts/${id}?revision=${revision}`, { method: "DELETE" });

export async function ensureBundledPlugin(name: string) {
  const plugins = await listPlugins();
  if (!plugins.plugins.some(plugin => plugin.id === name)) {
    const inspection = await api<Inspection>("/plugins/inspect", { method: "POST", body: JSON.stringify({ bundled: name }) });
    await api("/plugins/install", { method: "POST", body: JSON.stringify({
      staging_id: inspection.staging_id, digest: inspection.digest, revision: plugins.revision, secrets: {},
    }) });
  } else {
    const result = await api<Check>(`/plugins/${name}/check`, { method: "POST", body: JSON.stringify({ revision: plugins.revision }) });
    if (result.status === "needs_review") await api(`/plugins/${name}/update`, { method: "POST", body: JSON.stringify({
      revision: result.revision, staging_id: result.pending.staging_id, digest: result.pending.digest, secrets: {},
    }) });
  }
}

export async function addMailAccount(input: MailAccountInput) {
  await ensureBundledPlugin("mail");
  const { revision } = await listConnectors();
  return api("/connectors/mail/mail/accounts", { method: "POST", body: JSON.stringify({
    fields: { address: input.address, username: "", imap_host: input.imap_host, imap_port: "", imap_security: "",
      smtp_host: input.smtp_host, smtp_port: "", smtp_security: "" },
    secrets: { IMAP_PASSWORD: input.password }, handling: input.handling, revision,
  }) });
}
