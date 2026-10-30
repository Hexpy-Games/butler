// Conversations and projects for the composer `@` mention smoke, seeded through the
// isolated native gateway in a known recency order (oldest first).
import type { NativeAppServerHandle } from "./native-app-server.ts";
import type { NavigationView, ProjectSummary, SessionSummary } from "../../packages/butler-app/client/ui/src/app/types.ts";

export type MentionLocale = "ko" | "en";

type Titles = {
  projects: { butler: string; research: string; site: string; prototype: string; archived: string };
  /** The IME case: `@` + one composed syllable matches this conversation, then the prototype project. */
  prompt: string; imeQuery: string;
  home: string; interview: string; landing: string; composer: string; preview: string; design: string; current: string;
  /** Matches: a title prefix (design, research), a word (composer), inside a word (landing), the project name only (interview). */
  query: string;
  /** Matches only the research project (a title word) and the interview (its project name). */
  projectQuery: string;
  landingQuery: string;
  generalTitle: string;
};

export const MENTION_TITLES: Record<MentionLocale, Titles> = {
  ko: {
    projects: { butler: "butler", research: "디자인 리서치", site: "butler-site", prototype: "프로토타입", archived: "보관된 디자인" },
    prompt: "프롬프트 실험", imeQuery: "프",
    home: "홈페이지 문구 다듬기", interview: "사용자 인터뷰 정리", landing: "랜딩 페이지 리디자인", composer: "컴포저 디자인 검토",
    preview: "첨부 미리보기 시안", design: "디자인 시스템 정리", current: "오늘 할 일",
    query: "디자인", projectQuery: "리서치", landingQuery: "랜딩", generalTitle: "대화",
  },
  en: {
    projects: { butler: "butler", research: "Design research", site: "butler-site", prototype: "Prototype kit", archived: "Archived design" },
    prompt: "Prompt lab", imeQuery: "p",
    home: "Homepage copy polish", interview: "Interview notes", landing: "Landing page redesign", composer: "Composer design review",
    preview: "Attachment preview draft", design: "Design system cleanup", current: "Today's tasks",
    query: "design", projectQuery: "research", landingQuery: "landing", generalTitle: "Chats",
  },
};

export type MentionSeed = {
  titles: Titles;
  projects: { butler: string; research: string; site: string; prototype: string };
  sessions: Record<"prompt" | "home" | "interview" | "landing" | "general" | "composer" | "preview" | "design" | "current", string>;
};

// Distinct activity times even where the gateway stores whole seconds.
const tick = () => new Promise((done) => setTimeout(done, 1_100));

export async function seedMentions(server: NativeAppServerHandle, locale: MentionLocale): Promise<MentionSeed> {
  const titles = MENTION_TITLES[locale];
  const project = async (name: string) => (await server.api<{ project: ProjectSummary }>("/projects", {
    method: "POST", body: JSON.stringify({ source: "scratch", display_name: name }),
  })).project.id;
  const session = async (title: string, projectId?: string) => {
    await tick();
    return (await server.api<{ session: SessionSummary }>("/sessions", {
      method: "POST", body: JSON.stringify(projectId ? { kind: "project", project_id: projectId, title } : { kind: "chat", title }),
    })).session.id;
  };
  // Oldest: an archived project that would otherwise match every design query, and the IME case's items.
  const archived = await project(titles.projects.archived);
  await server.api(`/projects/${archived}`, { method: "PATCH", body: JSON.stringify({ archived: true }) });
  const prototype = await project(titles.projects.prototype);
  const prompt = await session(titles.prompt);
  const projects = { prototype, site: await project(titles.projects.site), research: await project(titles.projects.research), butler: await project(titles.projects.butler) };
  const sessions = {
    prompt,
    current: await session(titles.current),
    home: await session(titles.home, projects.site),
    interview: await session(titles.interview, projects.research),
    landing: await session(titles.landing),
    // A General message mid-way, so the general conversation is among the recent items.
    general: await tick().then(() => server.api("/messages", { method: "POST",
      body: JSON.stringify({ chat_id: "general", text: titles.generalTitle, client_message_id: `client-${crypto.randomUUID()}` }) })).then(() => "general"),
    composer: await session(titles.composer, projects.butler),
    preview: await session(titles.preview, projects.butler),
    design: await session(titles.design, projects.butler),
  };
  return { titles, projects, sessions };
}

/** Recency of every listed conversation and project, as the App lists them (`p:` projects, `s:` sessions). */
export async function mentionRecency(server: NativeAppServerHandle, generalTitle: string): Promise<Map<string, { title: string; recent: string }>> {
  const navigation = await server.api<NavigationView>("/navigation");
  const recency = new Map<string, { title: string; recent: string }>();
  const add = (session: SessionSummary) =>
    recency.set(`s:${session.id}`, { title: session.id === "general" ? generalTitle : session.title, recent: session.last_activity_at || session.updated_at || "" });
  for (const project of navigation.projects.filter((item) => !item.archived)) {
    recency.set(`p:${project.id}`, { title: project.display_name, recent: project.last_activity_at });
    for (const session of project.sessions ?? []) add(session);
  }
  for (const chat of navigation.chats) if (!recency.has(`s:${chat.id}`)) add(chat);
  return recency;
}
