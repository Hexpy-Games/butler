import type { MessageRecord, SessionArtifactSummary } from "@/app/types.ts";

/** One result per workspace path and content; keep its latest delivery. */
export function sessionArtifacts(
  summary: SessionArtifactSummary[], messages: MessageRecord[],
): SessionArtifactSummary[] {
  const latest = new Map<string, SessionArtifactSummary>();
  for (const artifact of [...summary, ...messages.flatMap(message => message.artifacts ?? [])]) {
    if (artifact.deliverable !== true) continue;
    const key = artifact.source_label && artifact.sha256
      ? JSON.stringify([artifact.source_label, artifact.sha256])
      : artifact.id;
    const previous = latest.get(key);
    if (!previous || artifact.created_at >= previous.created_at) latest.set(key, artifact);
  }
  return [...latest.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
}
