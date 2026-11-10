import { Stack, Typo } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { CanonProposal } from "@/app/canonProposals.ts";
import { canonProposalCopy } from "./canonProposalCopy.ts";
import { EpicMarkdown } from "./EpicMarkdown.tsx";
import { CanonProposalFact } from "./CanonProposalFact.tsx";
/** Only actionable fields appear; revisions remain concurrency tokens at the boundary. */
export function CanonProposalChanges({ changes }: { changes: CanonProposal["changes"] }) {
  const deletion = canonProposalCopy();
  const proposalCard = appCopy.canon.proposalCard;
  const labels: Record<string, string> = {
    "epic.delete": deletion.deleteEpic, "epic.edit": proposalCard.ops.epicEdit, "epic.move": proposalCard.ops.epicMove,
    "plan.create": proposalCard.ops.planCreate, "plan.edit": proposalCard.ops.planEdit,
    "plan.reorder": proposalCard.ops.planReorder, "spec.edit": proposalCard.ops.specEdit,
  };
  const visible = changes.filter(change => labels[change.op]);
  if (visible.length === 0) return null;
  return <Stack gap="lg">{visible.map((change, index) => <Stack gap="md" key={index}>
    {change.op !== "epic.move" && <Typo.Caption tone="secondary">{labels[change.op]}</Typo.Caption>}
    {(change.op === "epic.delete" || !change.op.startsWith("epic.")) && change.title && <Typo.PanelTitle wrap="anywhere">{change.title}</Typo.PanelTitle>}
    {change.op === "epic.delete" && <Typo.Caption>{deletion.deleteDetail}</Typo.Caption>}
    {!change.op.startsWith("epic.") && (change.body ?? change.description) && <EpicMarkdown epicId="" description={change.body ?? change.description ?? ""} density="compact" />}
    {(change.op === "epic.move" || change.status || change.assignee !== undefined || change.due_on !== undefined || change.order_titles) && <Stack gap="lg">
      {change.op === "epic.move" && <CanonProposalFact label={proposalCard.currentPlan} value={change.current_plan_title ?? proposalCard.backlog} />}
      {change.op === "epic.move" && <CanonProposalFact label={proposalCard.destinationPlan} value={change.destination_plan_title ?? proposalCard.backlog} />}
      {change.status && <CanonProposalFact label={appCopy.canon.status} value={appCopy.canon.statuses[change.status as keyof typeof appCopy.canon.statuses] ?? (change.status === "closed" ? proposalCard.closed : proposalCard.opened)} />}
      {change.assignee !== undefined && <CanonProposalFact label={appCopy.canon.assignee} value={change.assignee === "app-user" ? appCopy.canon.me : change.assignee ?? appCopy.canon.none} />}
      {change.due_on !== undefined && <CanonProposalFact label={appCopy.canon.dueOn} value={change.due_on ?? appCopy.canon.none} />}
      {change.order_titles && <CanonProposalFact label={proposalCard.order} value={change.order_titles.join(" → ")} />}
    </Stack>}
  </Stack>)}</Stack>;
}
