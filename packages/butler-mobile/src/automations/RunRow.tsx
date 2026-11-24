import { router } from "expo-router";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import type { AutomationRunSummary } from "../../../butler-protocol/src/index.ts";
import { timeLabel } from "@/conversation/sessions";
import { ListRow } from "@/ds";
import { useAppLocale } from "@/i18n";
import { runLabel } from "./automationLabels";

export function RunRow({ run, target, now }: { run: AutomationRunSummary; target: string; now: Date }) {
  const locale = useAppLocale(), copy = getAppCopy(locale).automations;
  return <ListRow title={runLabel(run, copy.runs)} meta={timeLabel(run.started_at, locale, now)}
    navigates={!!run.turn_id} onPress={run.turn_id ? () => router.push({ pathname: "/chat/[id]", params: { id: run.target_session_id, title: target } }) : undefined} />;
}
