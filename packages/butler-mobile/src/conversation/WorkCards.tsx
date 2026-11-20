import { useRouter } from "expo-router";
import type { SessionViewTurn, StewardChild, WorkerActivityWorkBlock } from "../../../butler-protocol/src/index.ts";
import { getAppCopy } from "../../../butler-i18n/src/index.ts";
import { WorkCard } from "@/ds";
import { useAppLocale, useMobileCopy } from "@/i18n";
import { blockStatus, progressRowLabel, stewardStatus, turnLatest } from "./workStatus";

export function StewardWorkCard({ child, turn }: { child: StewardChild; turn: SessionViewTurn }) {
  const router = useRouter();
  const locale = useAppLocale();
  const copy = useMobileCopy();
  const appCopy = getAppCopy(locale);
  const live = !!(child.active_turn || child.waiting_for_children);
  const status = stewardStatus(child, appCopy);
  const latest = turnLatest(child.active_turn ?? child.latest_turn, locale) ?? child.title;
  const details = (turn.progress?.safe_progress_rows ?? []).map(row => progressRowLabel(row, locale))
    .filter((label, index, labels) => index === 0 || label !== labels[index - 1]);
  return <WorkCard title={child.title} status={status.label} tone={status.tone} latest={latest} live={live} details={details}
    onOpen={() => router.push({ pathname: "/chat/[id]", params: { id: child.session_id, title: child.title } })}
    openLabel={copy.chat.openWork(child.title)}
    disclosureLabel={appCopy.conversation.work.disclosureLabel(status.label, latest, details.length)} />;
}

export function CompletedWorkCards({ blocks }: { blocks: WorkerActivityWorkBlock[] }) {
  const locale = useAppLocale();
  const copy = getAppCopy(locale);
  return <>{blocks.map(block => {
    const status = blockStatus(block.state, copy);
    const details = block.rows.map(row => progressRowLabel(row, locale));
    const latest = details.at(-1) ?? null;
    return <WorkCard key={block.id} title={block.label} status={status.label} tone={status.tone}
      latest={latest} live={false} details={details}
      disclosureLabel={copy.conversation.work.disclosureLabel(status.label, latest ?? "", details.length)} />;
  })}</>;
}
