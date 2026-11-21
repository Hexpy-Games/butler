import { useCallback, useEffect, useState } from "react";
import { Linking } from "react-native";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { useConversation } from "@/conversation/live";
import { ListGroup, ListRow } from "@/ds";
import { useAppLocale } from "@/i18n";
import { LoadState, SettingsScreen } from "@/settings/layout";
import type { AppInfoView } from "@/settings/types";

function repositoryLabel(href: string) {
  const url = new URL(href);
  return url.pathname.replace(/^\/+|\/+$/gu, "") || url.hostname;
}

export default function AboutSettings() {
  const app = getAppCopy(useAppLocale()), S = app.settings;
  const { client, reconcile } = useConversation();
  const [info, setInfo] = useState<AppInfoView | null>(null), [error, setError] = useState(false);
  const reload = useCallback(() => {
    if (!client) return;
    setError(false);
    void client.request<AppInfoView>("/app-info").then(setInfo).catch(() => setError(true));
  }, [client]);
  useEffect(reload, [reload, reconcile]);
  return <SettingsScreen title={S.sections.about}>
    <ListGroup label={S.pageSections.appInfo}>
      {!info ? <LoadState error={error} message={S.errors.loadAppInfo} onRetry={reload} /> : <>
        <ListRow title={S.fields.appName} meta={info.name ?? app.firstRun.product} />
        <ListRow title={S.fields.appVersion} meta={info.version} />
        <ListRow title={S.fields.appRepository} meta={info.repository_url ? repositoryLabel(info.repository_url) : "-"} onPress={info.repository_url ? () => void Linking.openURL(info.repository_url) : undefined} />
        <ListRow title={S.fields.appProtocol} meta={info.protocol_version} />
      </>}
    </ListGroup>
  </SettingsScreen>;
}
