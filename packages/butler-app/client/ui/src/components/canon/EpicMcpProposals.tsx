import { useMemo, useState } from "react";
import { diffArrays } from "diff";
import { appCopy, useAppLocale } from "@/app/copy.ts";
import { api } from "@/app/api.ts";
import { type CanonMcpProposal, type EpicDetail } from "@/app/canonApi.ts";
import { notifyError, notifyStatus } from "@/app/notifications.ts";
import { Button, ButtonContainer, ChangedLineDiff, Stack, Typo, type ChangedLineDiffLine } from "@/butler-ds";
import { canonActorLabel } from "./canonActorLabel.ts";
import { useCanonPersonName } from "./useCanonPersonName.ts";
export function EpicMcpProposals({ epic, onRefresh }: { epic: EpicDetail; onRefresh: () => Promise<void> }) {
  return <Stack gap="lg">{(epic.proposals ?? []).map(proposal => <McpProposal key={proposal.id} proposal={proposal} reload={onRefresh} />)}</Stack>;
}
function proposalLines(current: string, proposed: string): ChangedLineDiffLine[] {
  let oldLine = 1, newLine = 1;
  const result: ChangedLineDiffLine[] = [];
  for (const part of diffArrays(current ? current.split("\n") : [], proposed ? proposed.split("\n") : [])) {
    for (const content of part.value) {
      if (part.removed) result.push({ type: "deleted", old_line: oldLine++, content });
      else if (part.added) result.push({ type: "added", new_line: newLine++, content });
      else { oldLine++; newLine++; }
    }
  }
  return result;
}
function McpProposal({ proposal, reload }: { proposal: CanonMcpProposal; reload: () => Promise<void> }) {
  useAppLocale();
  const person = useCanonPersonName();
  const [busy, setBusy] = useState(false);
  const copy = appCopy.canon.mcp;
  const lines = useMemo(() => proposalLines(proposal.current_body ?? "", proposal.proposed_body), [proposal.current_body, proposal.proposed_body]);
  const resolve = async (outcome: "accepted" | "declined") => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api<{ ok?: boolean; error?: { code: string } }>(`/canon/proposals/${encodeURIComponent(proposal.id)}`, { method: "POST", body: JSON.stringify({ outcome }) });
      if (result.error?.code === "canon_conflict") notifyStatus(appCopy.canon.conflict);
      else if (result.error) throw new Error(appCopy.interfaceFeedback.requestFailed);
    } catch (error) {
      if ((error as { status?: number }).status === 409) { notifyStatus(appCopy.canon.conflict); }
      else notifyError(error, appCopy.interfaceFeedback.requestFailed);
    } finally {
      try { await reload(); } catch (error) { notifyError(error, appCopy.interfaceFeedback.requestFailed); }
      setBusy(false);
    }
  };
  return <Stack gap="sm" data-test-class="canon-mcp-proposal">
    <Typo.PanelSectionTitle wrap="anywhere">{copy.proposal} · {canonActorLabel(proposal.actor, person)}</Typo.PanelSectionTitle>
    <Typo.Body wrap="pre">{proposal.summary}</Typo.Body>
    <ChangedLineDiff id={`proposal-${proposal.id}`} ariaLabel={copy.proposal} lines={lines} />
    <ButtonContainer size="sm" justify="end">
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void resolve("declined")}>{copy.deny}</Button>
      <Button size="sm" disabled={busy} onClick={() => void resolve("accepted")}>{copy.apply}</Button>
    </ButtonContainer>
  </Stack>;
}
