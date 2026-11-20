import { useEffect, useState } from "react";
import { View } from "react-native";
import type { DashboardMaterialsPage, ProjectDashboardDocument } from "../../../butler-protocol/src/index.ts";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { ListRow, Sheet, Text, TextField, useTokens } from "@/ds";
import { useAppLocale, useMobileCopy } from "@/i18n";
import { useConversation } from "./live";
import { documentKindLabel } from "./documents";

export function ProjectDocumentsSheet({ open, onClose, projectId, onPick }: {
  open: boolean; onClose(): void; projectId: string; onPick(document: ProjectDashboardDocument): Promise<void>;
}) {
  const copy = useMobileCopy();
  const appCopy = getAppCopy(useAppLocale());
  const t = useTokens();
  const { client } = useConversation();
  const [documents, setDocuments] = useState<ProjectDashboardDocument[] | null>(null);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!open || !client || documents !== null) return;
    let cancelled = false;
    setError(false);
    const load = async () => {
      let cursor: string | null = null;
      const loaded: ProjectDashboardDocument[] = [];
      do {
        const query: URLSearchParams = new URLSearchParams({ all: "true", limit: "100", ...(cursor ? { cursor } : {}) });
        const page: DashboardMaterialsPage = await client.request(`/projects/${encodeURIComponent(projectId)}/dashboard/materials?${query}`);
        if (cancelled) return;
        if (page.status !== "ready") break;
        loaded.push(...page.documents);
        cursor = page.nextCursor;
      } while (cursor);
      setDocuments(loaded);
    };
    void load().catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [open, client, projectId, documents]);
  const visible = documents?.filter(document => document.title.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase())) ?? [];
  return <Sheet open={open} onClose={onClose} title={appCopy.interfaceDetails.projectDocuments} cancelLabel={copy.chat.close}>
    <View style={{ gap: t.length("--space-3") }}>
      <TextField label={appCopy.interfaceDetails.projectDocuments} placeholder={appCopy.interfaceDetails.searchDocuments}
        value={filter} onChangeText={setFilter} />
      {error ? <Text tone="danger">{appCopy.interfacePanels.projectDocumentsFailed}</Text>
        : documents !== null && !visible.length ? <Text>{appCopy.interfaceDetails.noDocuments}</Text> : null}
      {visible.map(document => <ListRow key={`${document.document_type ?? document.kind}:${document.id}`} title={document.title}
        meta={documentKindLabel(document.document_type ?? document.kind, appCopy)} description={document.safe_path_label}
        onPress={() => { onClose(); void onPick(document); }} />)}
    </View>
  </Sheet>;
}
