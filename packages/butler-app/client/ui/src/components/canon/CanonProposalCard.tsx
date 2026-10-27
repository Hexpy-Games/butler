import { CanonProposalChanges } from "./CanonProposalChanges.tsx";
import { useState } from "react";
import { Button, ButtonContainer, Card, Stack, Tag, Tooltip, Typo } from "@/butler-ds";
import { useAppLocale } from "@/app/copy.ts";
import { useProjectDashboardState } from "@/app/projectDashboardState.ts";
import { useButlerStore } from "@/app/store.ts";
import { resolveCanonProposal, type CanonProposal } from "@/app/canonProposals.ts";
import { notifyError } from "@/app/notifications.ts";
import { appCopy } from "@/app/copy.ts";
import { MessageAttachments } from "../conversation/MessageAttachments.tsx";
import { EpicMarkdown } from "./EpicMarkdown.tsx";
import { CanonProposalProject } from "./CanonProposalProject.tsx";
import { canonProposalCopy } from "./canonProposalCopy.ts";
import { useCanonProposal } from "./useCanonProposal.ts";

export function CanonProposalCard({ id, sessionId, projectId }: { id: string; sessionId: string; projectId: string | null }) {
  const { proposal, refresh } = useCanonProposal(id);
  return proposal ? <Proposal key={id} proposal={proposal} sessionId={sessionId} projectId={projectId} refresh={refresh} /> : null;
}
function Proposal({ proposal: p, sessionId, projectId, refresh }: {
  proposal: CanonProposal; sessionId: string; projectId: string | null; refresh: () => Promise<void>;
}) {
  const ko = useAppLocale().startsWith("ko");
  const copy = canonProposalCopy(ko);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState("new_name" in p.project ? "@new" : p.project.id ?? "@new");
  const [name, setName] = useState("new_name" in p.project ? p.project.new_name : "");
  const creates = p.changes.some(change => change.op === "epic.create");
  const apply = async (outcome: "accepted" | "declined") => {
    setBusy(true);
    try {
      await resolveCanonProposal(p.proposal_id, outcome, projectId ? undefined : target === "@new" ? { new_name: name } : { project_id: target });
      await refresh();
    } catch (error) { notifyError(error, appCopy.interfaceFeedback.requestFailed); }
    finally { setBusy(false); }
  };
  const open = () => {
    const project = "id" in p.project ? p.project.id : null;
    if (!project) return;
    const epic = p.changes.find(change => change.op.startsWith("epic.") && change.id)?.id;
    const app = useButlerStore.getState();
    useProjectDashboardState.getState().update(project, { tab: "board" });
    app.openProjectDashboard(project); app.setView({ kind: "project-dashboard", projectId: project, epicId: epic });
  };
  if (p.state !== "open") return <Card padding="sm" data-test-class="canon-proposal-card" data-proposal-id={p.proposal_id} data-state={p.state}>
    <Stack align="row" cross="center" justify="between" gap="sm">
      <Typo.Caption>{p.state === "applied" ? p.resolved_by === null ? copy.record : p.resolved_by === "chat" ? copy.chat : copy.added
        : p.state === "cancelled" ? copy.cancelled : p.state === "superseded" ? copy.superseded : copy.stale}</Typo.Caption>
      {p.state === "applied" && <ButtonContainer size="sm" justify="end"><Button size="sm" variant="link" onClick={open}>{copy.open}</Button></ButtonContainer>}
    </Stack>
  </Card>;
  const empty = !projectId && target === "@new" && !name.trim();
  return <Card radius="lg" data-test-class="canon-proposal-card" data-proposal-id={p.proposal_id} data-state={p.state}>
    <Stack gap="md">
      <Typo.Caption tone="tertiary">{creates ? copy.draft : copy.changes}</Typo.Caption>
      <Typo.Caption>{creates ? copy.target(p.plan?.title, target === "@new" ? name : undefined) : p.summary}</Typo.Caption>
      {p.epics.map((epic, index) => <Stack key={index} gap="sm">
        <Typo.PanelTitle wrap="anywhere">{epic.title}</Typo.PanelTitle>
        <EpicMarkdown epicId="" description={epic.description.replace(/!?\[[^\]]*\]\(attachment:[^)]+\)/giu, "")} density="compact" />
        <Stack align="row" gap="xs" wrap>{epic.tags.map((tag, index) => <Tag key={tag.id ?? index} tone={tag.color} size="sm">{tag.name}</Tag>)}</Stack>
        <MessageAttachments attachments={epic.attachments} sessionId={sessionId} />
      </Stack>)}
      <CanonProposalChanges changes={p.changes} ko={ko} />
      {!projectId && <CanonProposalProject value={target} name={name} busy={busy} ko={ko} onSelect={setTarget} onName={setName} />}
      <ButtonContainer size="sm" justify="end">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void apply("declined")}>{copy.cancel}</Button>
        <Tooltip wrap label={empty ? copy.name : undefined}><Button size="sm" disabled={busy} aria-disabled={empty || undefined} onClick={() => void apply("accepted")}>{creates ? copy.add : copy.apply}</Button></Tooltip>
      </ButtonContainer>
    </Stack>
  </Card>;
}
