import { apiErrorCode } from "@/app/api.ts";
import { CanonProposalChanges } from "./CanonProposalChanges.tsx";
import { useState } from "react";
import { Button, ButtonContainer, Card, Stack, Tag, Tooltip, Typo } from "@/butler-ds";
import { useAppLocale } from "@/app/copy.ts";
import { openCanonEpic } from "./canonNavigation.ts";
import { ChatEpicCards } from "./ChatEpicCards.tsx";
import { useButlerStore } from "@/app/store.ts";
import { resolveCanonProposal, type CanonProposal } from "@/app/canonProposals.ts";
import { notifyError, notifyStatus } from "@/app/notifications.ts";
import { appCopy } from "@/app/copy.ts";
import { MessageAttachments } from "../conversation/MessageAttachments.tsx";
import { EpicMarkdown } from "./EpicMarkdown.tsx";
import { CanonProposalProject } from "./CanonProposalProject.tsx";
import { CanonProposalFact } from "./CanonProposalFact.tsx";
import { canonProposalCopy } from "./canonProposalCopy.ts";
import { useCanonProposals } from "./useCanonProposal.ts";

const projectOf = (p: CanonProposal) => "id" in p.project ? p.project.id ?? null : null;
/** A reply's proposals: drafts and other settled rows stay one per proposal; applied ones merge into one receipt per project. */
export function CanonProposalCards({ ids, sessionId, projectId, shown }: { ids: readonly string[]; sessionId: string; projectId: string | null; shown?: ReadonlySet<string> }) {
  const { proposals, refresh } = useCanonProposals(ids);
  return <>{proposals.map(p => {
    if (p.state !== "applied") return <Proposal key={p.proposal_id} proposal={p} sessionId={sessionId} projectId={projectId} refresh={() => refresh(p.proposal_id)} />;
    const group = proposals.filter(other => other.state === "applied" && projectOf(other) === projectOf(p));
    return group[0] === p ? <AppliedReceipt key={p.proposal_id} proposals={group} shown={shown} /> : null;
  })}</>;
}
function AppliedReceipt({ proposals, shown }: { proposals: CanonProposal[]; shown?: ReadonlySet<string> }) {
  const copy = canonProposalCopy(useAppLocale().startsWith("ko"));
  const [first] = proposals;
  const project = projectOf(first);
  const changes = proposals.flatMap(p => p.changes);
  const deletes = changes.some(change => change.op === "epic.delete");
  const mixedDelete = deletes && changes.some(change => change.op !== "epic.delete");
  const created = changes.flatMap(change => change.op === "epic.create" && change.id && !shown?.has(change.id) ? [change.id] : []);
  const open = () => {
    if (!project) return;
    openCanonEpic(project, changes.find(change => change.op.startsWith("epic.") && change.op !== "epic.delete" && change.id)?.id);
  };
  return <Stack gap="sm"><Card padding="sm" data-test-class="canon-proposal-card" data-proposal-id={first.proposal_id} data-state="applied">
    <Stack align="row" cross="center" justify="between" gap="sm">
      <Typo.Caption>{deletes ? mixedDelete ? copy.changed : copy.deleted : first.resolved_by === null ? copy.record : first.resolved_by === "chat" ? copy.chat : copy.added}</Typo.Caption>
      <ButtonContainer size="sm" justify="end"><Button size="sm" variant="link" onClick={open}>{copy.open}</Button></ButtonContainer>
    </Stack>
  </Card>
    {project && created.length > 0 && <ChatEpicCards projectId={project} ids={created} />}
  </Stack>;
}
function Proposal({ proposal: p, sessionId, projectId, refresh }: {
  proposal: CanonProposal; sessionId: string; projectId: string | null; refresh: () => Promise<void>;
}) {
  const ko = useAppLocale().startsWith("ko");
  const copy = canonProposalCopy(ko);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState("new_name" in p.project ? "@new" : p.project.id ?? "@new");
  const [name, setName] = useState("new_name" in p.project ? p.project.new_name : "");
  const projects = useButlerStore(state => state.navigation.projects);
  const chooseProject = !projectId || !("id" in p.project) || p.project.id !== projectId;
  const projectName = target === "@new" ? `${copy.newProject}: ${name}` : projects.find(project => project.id === target)?.display_name ?? ("name" in p.project ? p.project.name : "");
  const deletes = p.changes.some(change => change.op === "epic.delete");
  const mixedDelete = deletes && p.changes.some(change => change.op !== "epic.delete");
  const creates = p.changes.some(change => change.op === "epic.create");
  const apply = async (outcome: "accepted" | "declined") => {
    setBusy(true);
    try {
      const result = await resolveCanonProposal(p.proposal_id, outcome, !chooseProject ? undefined : target === "@new" ? { new_name: name } : { project_id: target });
      if (!result.ok) notifyStatus(result.error?.code === "canon_not_found" ? appCopy.canon.deletion.missing : appCopy.canon.conflict, { tone: "error" });
      await refresh();
    } catch (error) {
      if (apiErrorCode(error) === "running") notifyStatus(appCopy.canon.deletion.running, { tone: "error" });
      else notifyError(error, appCopy.interfaceFeedback.requestFailed);
    }
    finally { setBusy(false); }
  };
  if (p.state !== "open") return <Card padding="sm" data-test-class="canon-proposal-card" data-proposal-id={p.proposal_id} data-state={p.state}>
    <Typo.Caption>{p.state === "cancelled" ? copy.cancelled : p.state === "superseded" ? copy.superseded : copy.stale}</Typo.Caption>
  </Card>;
  const empty = chooseProject && target === "@new" && !name.trim();
  return <Card radius="lg" data-test-class="canon-proposal-card" data-proposal-id={p.proposal_id} data-state={p.state}>
    <Stack gap="lg">
      <Stack gap="md">
        <Typo.Caption tone="tertiary">{creates && !deletes ? copy.draft : copy.changes}</Typo.Caption>
        <Typo.Caption>{creates ? copy.target(p.plan?.title, target === "@new" ? name : undefined) : p.target_label}</Typo.Caption>
        {p.epics.map((epic, index) => {
          const description = epic.description.replace(/!?\[[^\]]*\]\(attachment:[^)]+\)/giu, "");
          return <Stack key={index} gap="sm">
            <Typo.PanelTitle wrap="anywhere">{epic.title}</Typo.PanelTitle>
            {description.trim() && <EpicMarkdown epicId="" description={description} density="compact" />}
            {epic.tags.length > 0 && <Stack align="row" gap="xs" wrap>{epic.tags.map((tag, index) => <Tag key={tag.id ?? index} tone={tag.color} size="sm">{tag.name}</Tag>)}</Stack>}
            <MessageAttachments attachments={epic.attachments} sessionId={sessionId} />
          </Stack>;
        })}
        <CanonProposalChanges changes={p.changes} ko={ko} />
      </Stack>
      {chooseProject ? <CanonProposalProject value={target} name={name} busy={busy} ko={ko} onSelect={setTarget} onName={setName} />
        : <CanonProposalFact label={copy.project} value={projectName} />}
      <ButtonContainer size="sm" justify="end">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void apply("declined")}>{copy.cancel}</Button>
        <Tooltip wrap label={empty ? copy.name : undefined}><Button size="sm" variant={deletes ? "destructive" : "default"} disabled={busy} aria-disabled={empty || undefined} onClick={() => void apply("accepted")}>{deletes ? mixedDelete ? creates ? copy.addDelete : copy.changeDelete : copy.deleteEpic : creates ? copy.add : copy.apply}</Button></Tooltip>
      </ButtonContainer>
    </Stack>
  </Card>;
}
