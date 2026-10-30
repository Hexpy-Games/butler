import { sessionDisplayTitle } from "@/app/sessionTitle.ts";
import type { NavigationView, SessionSummary } from "@/app/types.ts";

/** One `@` mention target: a conversation or a whole project. */
export interface MentionCandidate {
  kind: "session" | "project";
  id: string;
  title: string;
  /** The project a project conversation belongs to. */
  projectName?: string;
  inProject: boolean;
  /** Last use or change (ISO time); newer first. */
  recent: string;
  /** Lowercased title and project name, computed once per navigation snapshot. */
  search: { title: string; words: string[]; project: string };
}

export const MENTION_LIMIT = 7;
const WORD_BREAK = /[\s\-_/·.,:;()[\]{}]+/u;

function candidate(kind: MentionCandidate["kind"], id: string, title: string, recent: string, projectName?: string): MentionCandidate {
  const lower = title.toLocaleLowerCase();
  return {
    kind, id, title, projectName, inProject: projectName !== undefined, recent,
    search: { title: lower, words: lower.split(WORD_BREAK).filter(Boolean), project: projectName?.toLocaleLowerCase() ?? "" },
  };
}

const sessionCandidate = (session: SessionSummary, projectName?: string) =>
  candidate("session", session.id, sessionDisplayTitle(session), session.last_activity_at || session.updated_at || "", projectName);

/** Every conversation and project the client already lists, except the conversation being written in. */
export function mentionCandidates(navigation: NavigationView, currentSessionId: string): MentionCandidate[] {
  const all = [
    ...navigation.projects.filter(project => !project.archived).flatMap(project => [
      candidate("project", project.id, project.display_name, project.last_activity_at),
      ...(project.sessions ?? []).filter(session => !session.archived).map(session => sessionCandidate(session, project.display_name)),
    ]),
    ...navigation.chats.filter(chat => !chat.archived).map(chat => sessionCandidate(chat)),
  ];
  const seen = new Set([currentSessionId]);
  return all.filter(item => item.kind === "project" || (!seen.has(item.id) && seen.add(item.id)));
}

/** Lower is better: the title starts with the query, a title word does, the title contains it, only the project name does. */
function matchRank(item: MentionCandidate, query: string): number | null {
  if (item.search.title.startsWith(query)) return 0;
  if (item.search.words.some(word => word.startsWith(query))) return 1;
  if (item.search.title.includes(query)) return 2;
  return item.search.project.includes(query) ? 3 : null;
}

const newerFirst = (a: MentionCandidate, b: MentionCandidate) => (a.recent < b.recent ? 1 : a.recent > b.recent ? -1 : 0);

/** A bare `@` lists the most recent items; a typed query lists matches by quality, then recency. */
export function rankMentions(candidates: MentionCandidate[], rawQuery: string): MentionCandidate[] {
  const query = rawQuery.toLocaleLowerCase();
  if (!query) return [...candidates].sort(newerFirst).slice(0, MENTION_LIMIT);
  return candidates
    .flatMap(item => { const rank = matchRank(item, query); return rank === null ? [] : [{ item, rank }]; })
    .sort((a, b) => a.rank - b.rank || newerFirst(a.item, b.item))
    .slice(0, MENTION_LIMIT)
    .map(entry => entry.item);
}
