import { useTransition } from "react";
import { useLocalSearchParams } from "expo-router";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { RunRow } from "@/automations/RunRow";
import { useAutomationRuns } from "@/automations/useAutomationRuns";
import { ListGroup } from "@/ds";
import { useAppLocale } from "@/i18n";
import { LoadState, SettingsScreen } from "@/settings/layout";

export default function AutomationRuns() {
  const { id, target } = useLocalSearchParams<{ id: string; title: string; target: string }>();
  const app = getAppCopy(useAppLocale());
  const { runs, failed, reload, more: loadMore, hasMore } = useAutomationRuns(id);
  const [loadingMore, startTransition] = useTransition();
  const more = () => {
    const page = loadMore();
    if (page) startTransition(() => page);
  };
  const now = new Date();
  return <SettingsScreen title={app.automations.fields.runs} onEndReached={more}>
    <ListGroup>
      {!runs || failed ? <LoadState error={failed} onRetry={reload} />
        : runs.map(run => <RunRow key={run.id} run={run} target={target} now={now} />)}
      {loadingMore && hasMore ? <LoadState error={false} onRetry={reload} /> : null}
    </ListGroup>
  </SettingsScreen>;
}
