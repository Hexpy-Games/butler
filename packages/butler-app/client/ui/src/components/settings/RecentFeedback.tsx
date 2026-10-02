import { Button, MetaList, SettingsSection, Spinner, Stack, Typo } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import { relativeAge } from "@/app/utils.ts";
import { useFeedback } from "./hooks/useFeedback";
import { feedbackExpiry, feedbackScope } from "./feedbackTypes";
import type { MemoryProject } from "./memoryTypes";
export function RecentFeedback({ projects }: { projects: MemoryProject[] }) {
  const feedback = useFeedback(projects);
  const copy = appCopy.settings.memory;
  return <SettingsSection id="recent-feedback" kind="list" title={copy.feedback.title} description={copy.feedback.description}
    state={feedback.state} emptyMessage={copy.feedback.empty} onRetry={() => { void feedback.reload(); }}
    actions={<Button variant="outline" text={copy.feedback.reset} disabled={feedback.state !== "ready" || Boolean(feedback.busy)}
      aria-busy={feedback.busy === "reset" || undefined} onClick={() => { void feedback.change(); }} />}>
    <MetaList items={[{ label: copy.facts.entries, value: String(feedback.rows.length) },
      ...(feedback.updated ? [{ label: copy.facts.updated, value: copy.ago(relativeAge(feedback.updated)) }] : [])]} />
    {feedback.rows.map((item) => <Stack key={item.feedback_id} align="row" cross="start" gap="md" role="group"
      aria-labelledby={`feedback-text-${item.feedback_id}`} data-test-class="feedback-row">
      <Stack gap="none" grow minWidth="0">
        <Typo.Body as="div" id={`feedback-text-${item.feedback_id}`} wrap="pre" alignWith="control">{item.text}</Typo.Body>
        <Typo.Caption tone="secondary" wrap="anywhere">{feedbackScope(item, projects)} · {feedbackExpiry(item)}</Typo.Caption>
      </Stack>
      <Button variant="outline" disabled={Boolean(feedback.busy)} aria-describedby={`feedback-text-${item.feedback_id}`}
        aria-busy={feedback.busy === item.feedback_id || undefined} text={appCopy.common.delete}
        iconStart={feedback.busy === item.feedback_id ? <Spinner size={14} /> : undefined} onClick={() => { void feedback.change(item); }} />
    </Stack>)}
  </SettingsSection>;
}
