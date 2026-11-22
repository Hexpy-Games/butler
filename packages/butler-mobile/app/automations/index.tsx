import { useCallback, useState } from "react";
import { router, useFocusEffect } from "expo-router";
import type { AutomationSummary } from "../../../butler-protocol/src/index.ts";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { automationMeta } from "@/automations/automationLabels";
import { useConversation } from "@/conversation/live";
import { icons, ListGroup, ListGroupItem, ListRow, Text } from "@/ds";
import { useAppLocale } from "@/i18n";
import { LoadState, SettingsScreen } from "@/settings/layout";

export default function Automations() {
  const locale = useAppLocale(), copy = getAppCopy(locale).automations;
  const { client } = useConversation();
  const [automations, setAutomations] = useState<AutomationSummary[]>([]);
  const [loading, setLoading] = useState(true), [error, setError] = useState(false);
  const load = useCallback(async () => {
    setLoading(true); setError(false);
    try { setAutomations((await client!.request<{ automations: AutomationSummary[] }>("/automations")).automations); }
    catch { setError(true); }
    finally { setLoading(false); }
  }, [client]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));
  return <SettingsScreen title={copy.title}>
    <ListGroup>{loading || error ? <LoadState error={error} onRetry={load} />
      : automations.length ? automations.map(a => <ListRow key={a.id} icon={icons.Clock3} title={a.title}
        description={automationMeta(a, copy, locale)} descriptionLines={1} navigates
        onPress={() => router.push({ pathname: "/automations/[id]", params: { id: a.id, title: a.title } })} />)
        : <ListGroupItem><Text variant="caption">{copy.empty}</Text></ListGroupItem>}
    </ListGroup>
  </SettingsScreen>;
}
