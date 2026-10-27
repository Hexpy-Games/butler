import { KeyValueRow, Stack, Typo } from "@/butler-ds";
import { appCopy } from "@/app/copy.ts";
import type { CanonProposal } from "@/app/canonProposals.ts";
import { EpicMarkdown } from "./EpicMarkdown.tsx";
/** Only actionable fields appear; revisions remain concurrency tokens at the boundary. */
export function CanonProposalChanges({ changes, ko }: { changes: CanonProposal["changes"]; ko: boolean }) {
  const labels: Record<string, string> = ko ? {
    "epic.edit": "과제 변경", "epic.move": "과제 이동", "plan.create": "계획 등록", "plan.edit": "계획 변경", "plan.reorder": "순서 변경", "spec.edit": "명세 변경",
  } : { "epic.edit": "Edit Epic", "epic.move": "Move Epic", "plan.create": "Add plan", "plan.edit": "Edit plan", "plan.reorder": "Reorder", "spec.edit": "Edit spec" };
  return <Stack gap="md">{changes.filter(change => labels[change.op]).map((change, index) => <Stack gap="sm" key={index}>
    <Typo.Caption tone="secondary">{labels[change.op]}</Typo.Caption>
    {!change.op.startsWith("epic.") && change.title && <Typo.PanelTitle wrap="anywhere">{change.title}</Typo.PanelTitle>}
    {!change.op.startsWith("epic.") && (change.body ?? change.description) && <EpicMarkdown epicId="" description={change.body ?? change.description ?? ""} density="compact" />}
    {change.op === "epic.move" && <KeyValueRow label={ko ? "대상 계획" : "Destination plan"} value={change.destination_plan_title ?? (ko ? "백로그" : "Backlog")} />}
    {change.status && <KeyValueRow label={appCopy.canon.status} value={appCopy.canon.statuses[change.status as keyof typeof appCopy.canon.statuses] ?? (change.status === "closed" ? ko ? "닫힘" : "Closed" : ko ? "열림" : "Open")} />}
    {change.assignee !== undefined && <KeyValueRow label={appCopy.canon.assignee} value={change.assignee === "app-user" ? appCopy.canon.me : change.assignee ?? appCopy.canon.none} />}
    {change.due_on !== undefined && <KeyValueRow label={appCopy.canon.dueOn} value={change.due_on ?? appCopy.canon.none} />}
    {change.order_titles && <KeyValueRow label={ko ? "순서" : "Order"} value={change.order_titles.join(" → ")} />}
  </Stack>)}</Stack>;
}
