import { Stack, Typo } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { CanonProposal } from "@/app/canonProposals.ts";
import { canonProposalCopy } from "./canonProposalCopy.ts";
import { EpicMarkdown } from "./EpicMarkdown.tsx";
import { CanonProposalFact } from "./CanonProposalFact.tsx";
/** Only actionable fields appear; revisions remain concurrency tokens at the boundary. */
export function CanonProposalChanges({ changes, ko }: { changes: CanonProposal["changes"]; ko: boolean }) {
  const labels: Record<string, string> = ko ? {
    "epic.edit": "과제 변경", "epic.move": "과제 이동", "plan.create": "계획 등록", "plan.edit": "계획 변경", "plan.reorder": "순서 변경", "spec.edit": "명세 변경",
  } : { "epic.edit": "Edit Epic", "epic.move": "Move Epic", "plan.create": "Add plan", "plan.edit": "Edit plan", "plan.reorder": "Reorder", "spec.edit": "Edit spec" };
  const visible = changes.filter(change => labels[change.op]);
  if (visible.length === 0) return null;
  return <Stack gap="lg">{visible.map((change, index) => <Stack gap="md" key={index}>
    {change.op !== "epic.move" && <Typo.Caption tone="secondary">{labels[change.op]}</Typo.Caption>}
    {!change.op.startsWith("epic.") && change.title && <Typo.PanelTitle wrap="anywhere">{change.title}</Typo.PanelTitle>}
    {!change.op.startsWith("epic.") && (change.body ?? change.description) && <EpicMarkdown epicId="" description={change.body ?? change.description ?? ""} density="compact" />}
    {(change.op === "epic.move" || change.status || change.assignee !== undefined || change.due_on !== undefined || change.order_titles) && <Stack gap="lg">
      {change.op === "epic.move" && <CanonProposalFact label={canonProposalCopy(ko).currentPlan} value={change.current_plan_title ?? (ko ? "백로그" : "Backlog")} />}
      {change.op === "epic.move" && <CanonProposalFact label={ko ? "대상 계획" : "Destination plan"} value={change.destination_plan_title ?? (ko ? "백로그" : "Backlog")} />}
      {change.status && <CanonProposalFact label={appCopy.canon.status} value={appCopy.canon.statuses[change.status as keyof typeof appCopy.canon.statuses] ?? (change.status === "closed" ? ko ? "닫힘" : "Closed" : ko ? "열림" : "Open")} />}
      {change.assignee !== undefined && <CanonProposalFact label={appCopy.canon.assignee} value={change.assignee === "app-user" ? appCopy.canon.me : change.assignee ?? appCopy.canon.none} />}
      {change.due_on !== undefined && <CanonProposalFact label={appCopy.canon.dueOn} value={change.due_on ?? appCopy.canon.none} />}
      {change.order_titles && <CanonProposalFact label={ko ? "순서" : "Order"} value={change.order_titles.join(" → ")} />}
    </Stack>}
  </Stack>)}</Stack>;
}
