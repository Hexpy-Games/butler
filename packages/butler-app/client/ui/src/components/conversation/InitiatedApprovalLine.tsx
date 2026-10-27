import { approvalActionView, normalizeApprovalSummary } from "@/app/approvalRequest";
import { appCopy, useAppLocale } from "@/app/copy";
import type { InitiatedOrigin } from "@/app/initiatedTypes";
import { useButlerStore } from "@/app/store";
import { Clickable, Stack, Tag, Typo } from "@/butler-ds";

export function InitiatedApprovalLine({ origin }: { origin: InitiatedOrigin }) {
  useAppLocale();
  const approval = normalizeApprovalSummary(origin.approval);
  if (!approval) return null;
  const view = approvalActionView(approval, appCopy.interfaceTemplates.approvalRequest, appCopy.guided.tools);
  const open = () => {
    const store = useButlerStore.getState();
    if (origin.work_session_id) store.openSessionObserver(origin.work_session_id);
    else if (origin.automation_id) store.setView({ kind: "automation-detail", automationId: origin.automation_id });
  };
  return <Clickable variant="text" onClick={open} data-test-class="initiated-approval-needed">
    <Stack align="row" cross="start" gap="xs">
      <Stack.Item shrink={false}><Tag>{appCopy.conversation.initiated.needsApproval}</Tag></Stack.Item>
      <Typo.Body as="span" minWidth="0" wrap="anywhere">{[origin.label || view.label, view.target, origin.automation_title].filter(Boolean).join(" · ")}</Typo.Body>
    </Stack>
  </Clickable>;
}
