/// <reference types="bun" />

import { expect, test } from "bun:test";
import type { NavigationView, SessionSummary } from "@/app/types.ts";
import {
  applyLiveNavigationEvent,
  createLiveNavigationReconciliation,
} from "./liveNavigationReconciliation.ts";

const projectSession = (input: {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  pinned?: boolean;
  archived?: boolean;
}): SessionSummary => ({
  id: input.id,
  kind: "project",
  title: input.title,
  project_id: input.projectId,
  created_at: input.createdAt,
  updated_at: input.updatedAt,
  last_activity_at: input.updatedAt,
  pinned: input.pinned ?? false,
  archived: input.archived ?? false,
});

const navigation = (): NavigationView => ({
  chats: [],
  projects: [
    {
      id: "project-one",
      display_name: "Project One",
      last_activity_at: "2026-08-08T00:00:00.000Z",
      pinned: false,
      archived: false,
      sessions: [
        projectSession({
          id: "session-old",
          projectId: "project-one",
          title: "오래된 세션",
          createdAt: "2026-08-07T00:00:00.000Z",
          updatedAt: "2026-08-08T00:00:00.000Z",
        }),
      ],
    },
    {
      id: "project-two",
      display_name: "Project Two",
      last_activity_at: "2026-08-08T00:00:00.000Z",
      pinned: false,
      archived: false,
      sessions: [],
    },
  ],
  automations_summary: { total_count: 0, enabled_count: 0 },
  settings_summary: { profile_label: "Test" },
});

test("live project session events merge safely, sort canonically, and replay idempotently", () => {
  const created = {
    type: "session.created",
    payload: {
      session: {
        ...projectSession({
          id: "session-new",
          projectId: "project-one",
          title: "생성 제목",
          createdAt: "2026-08-08T00:01:00.000Z",
          updatedAt: "2026-08-08T00:02:00.000Z",
        }),
        session_hint: "safe-server-hint",
        private_prompt: "ignore me",
      },
    },
  } as const;
  const updated = {
    type: "session.updated",
    payload: {
      session: {
        ...projectSession({
          id: "session-new",
          projectId: "project-one",
          title: "최신 제목",
          createdAt: "2026-08-08T00:01:00.000Z",
          updatedAt: "2026-08-08T00:03:00.000Z",
          pinned: true,
        }),
      },
    },
  } as const;
  const first = applyLiveNavigationEvent(
    applyLiveNavigationEvent(navigation(), created),
    updated,
  );
  const replay = applyLiveNavigationEvent(first, updated);
  const sessions = first.projects[0]?.sessions ?? [];
  expect(sessions[0]?.id).toBe("session-new");
  expect(sessions[0]?.title).toBe("최신 제목");
  expect(sessions[0]?.pinned).toBe(true);
  expect(sessions).toHaveLength(2);
  expect(replay).toEqual(first);
  expect(JSON.stringify(first)).not.toContain("private_prompt");
});

test("live session ordering follows pinned, updated, created, then prior-order ties", () => {
  const base = navigation();
  const seeded: NavigationView = {
    ...base,
    projects: base.projects.map((project) => project.id === "project-one"
      ? {
          ...project,
          sessions: [
            projectSession({
              id: "tie-b",
              projectId: "project-one",
              title: "Tie B",
              createdAt: "2026-08-08T00:02:00.000Z",
              updatedAt: "2026-08-08T00:02:00.000Z",
            }),
            projectSession({
              id: "tie-a",
              projectId: "project-one",
              title: "Tie A",
              createdAt: "2026-08-08T00:02:00.000Z",
              updatedAt: "2026-08-08T00:02:00.000Z",
            }),
          ],
        }
      : project),
  };
  const event = (input: Parameters<typeof projectSession>[0]) => ({
    type: "session.created" as const,
    payload: { session: projectSession(input) },
  });
  const sorted = [
    event({
      id: "created-later",
      projectId: "project-one",
      title: "Created later",
      createdAt: "2026-08-08T00:05:00.000Z",
      updatedAt: "2026-08-08T00:03:00.000Z",
    }),
    event({
      id: "updated-later",
      projectId: "project-one",
      title: "Updated later",
      createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:04:00.000Z",
    }),
    event({
      id: "pinned-old",
      projectId: "project-one",
      title: "Pinned old",
      createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:00:00.000Z",
      pinned: true,
    }),
  ].reduce(applyLiveNavigationEvent, seeded);
  expect(sorted.projects[0]?.sessions?.map((session) => session.id)).toEqual([
    "pinned-old",
    "updated-later",
    "created-later",
    "tie-b",
    "tie-a",
  ]);

  const moved = applyLiveNavigationEvent(sorted, {
    type: "session.updated",
    payload: {
      session: projectSession({
        id: "created-later",
        projectId: "project-one",
        title: "Updated newest",
        createdAt: "2026-08-08T00:05:00.000Z",
        updatedAt: "2026-08-08T00:06:00.000Z",
      }),
    },
  });
  expect(moved.projects[0]?.sessions?.map((session) => session.id)).toEqual([
    "pinned-old",
    "created-later",
    "updated-later",
    "tie-b",
    "tie-a",
  ]);
  expect(applyLiveNavigationEvent(moved, {
    type: "session.updated",
    payload: {
      session: projectSession({
        id: "created-later",
        projectId: "project-one",
        title: "Stale replay",
        createdAt: "2026-08-08T00:05:00.000Z",
        updatedAt: "2026-08-08T00:06:00.000Z",
      }),
    },
  })).toEqual(moved);
});

test("live navigation rejects stale or cross-project identity and removes archive/delete", () => {
  const base = navigation();
  const withCreated = applyLiveNavigationEvent(base, {
    type: "session.created",
    payload: {
      session: projectSession({
        id: "session-new",
        projectId: "project-one",
        title: "새 세션",
        createdAt: "2026-08-08T00:01:00.000Z",
        updatedAt: "2026-08-08T00:02:00.000Z",
      }),
    },
  });
  const stale = applyLiveNavigationEvent(withCreated, {
    type: "session.updated",
    payload: {
      session: projectSession({
        id: "session-new",
        projectId: "project-one",
        title: "오래된 제목",
        createdAt: "2026-08-08T00:01:00.000Z",
        updatedAt: "2026-08-08T00:01:00.000Z",
      }),
    },
  });
  const crossProject = applyLiveNavigationEvent(stale, {
    type: "session.created",
    payload: {
      session: projectSession({
        id: "session-new",
        projectId: "project-two",
        title: "잘못된 프로젝트",
        createdAt: "2026-08-08T00:04:00.000Z",
        updatedAt: "2026-08-08T00:04:00.000Z",
      }),
    },
  });
  const archived = applyLiveNavigationEvent(crossProject, {
    type: "session.updated",
    payload: {
      session: {
        ...projectSession({
          id: "session-new",
          projectId: "project-one",
          title: "보관",
          createdAt: "2026-08-08T00:01:00.000Z",
          updatedAt: "2026-08-08T00:05:00.000Z",
          archived: true,
        }),
      },
    },
  });
  const deleted = applyLiveNavigationEvent(archived, {
    type: "session.permanently_deleted",
    payload: { session: { id: "session-old" } },
  });
  const unarchived = applyLiveNavigationEvent(archived, {
    type: "session.updated",
    payload: {
      session: projectSession({
        id: "session-new",
        projectId: "project-one",
        title: "다시 표시",
        createdAt: "2026-08-08T00:01:00.000Z",
        updatedAt: "2026-08-08T00:06:00.000Z",
        archived: false,
      }),
    },
  });
  const staleUnarchived = applyLiveNavigationEvent(archived, {
    type: "session.updated",
    payload: {
      session: projectSession({
        id: "session-new",
        projectId: "project-one",
        title: "오래된 다시 표시",
        createdAt: "2026-08-08T00:01:00.000Z",
        updatedAt: "2026-08-08T00:04:00.000Z",
        archived: false,
      }),
    },
  });
  expect(stale.projects[0]?.sessions?.find((session) => session.id === "session-new")?.title)
    .toBe("새 세션");
  expect(crossProject.projects[1]?.sessions).toEqual([]);
  expect(archived.projects[0]?.sessions?.map((session) => session.id)).toEqual([
    "session-old",
  ]);
  expect(unarchived).toEqual(archived);
  expect(staleUnarchived.projects[0]?.sessions?.some(
    (session) => session.id === "session-new",
  )).toBe(false);
  expect(deleted.projects[0]?.sessions).toEqual([]);
});

test("navigation sanitizer fails closed for malformed known fields and absent projects", () => {
  const base = navigation();
  const malformed = applyLiveNavigationEvent(base, {
    type: "session.created",
    payload: {
      session: {
        ...projectSession({
          id: "session-invalid",
          projectId: "project-one",
          title: "잘못된 세션",
          createdAt: "2026-08-08T00:01:00.000Z",
          updatedAt: "2026-08-08T00:01:00.000Z",
        }),
        pinned: "true",
      },
    },
  });
  const missingRequired = applyLiveNavigationEvent(base, {
    type: "session.created",
    payload: {
      session: {
        ...projectSession({
          id: "session-invalid",
          projectId: "project-one",
          title: "잘못된 세션",
          createdAt: "2026-08-08T00:01:00.000Z",
          updatedAt: "2026-08-08T00:01:00.000Z",
        }),
        last_activity_at: undefined,
      },
    },
  });
  const absentProject = applyLiveNavigationEvent(base, {
    type: "session.created",
    payload: {
      session: projectSession({
        id: "session-absent-project",
        projectId: "project-missing",
        title: "없는 프로젝트",
        createdAt: "2026-08-08T00:01:00.000Z",
        updatedAt: "2026-08-08T00:01:00.000Z",
      }),
    },
  });
  const malformedChat = applyLiveNavigationEvent(base, {
    type: "session.created",
    payload: {
      session: {
        ...projectSession({
          id: "session-chat",
          projectId: "project-one",
          title: "채팅",
          createdAt: "2026-08-08T00:01:00.000Z",
          updatedAt: "2026-08-08T00:01:00.000Z",
        }),
        kind: "chat",
      },
    },
  });
  const mismatchedNestedProject = applyLiveNavigationEvent(base, {
    type: "session.created",
    payload: {
      session: {
        ...projectSession({
          id: "session-nested-project",
          projectId: "project-one",
          title: "잘못된 중첩 프로젝트",
          createdAt: "2026-08-08T00:01:00.000Z",
          updatedAt: "2026-08-08T00:01:00.000Z",
        }),
        project: { id: "project-two", display_name: "Wrong project" },
      },
    },
  });
  expect(malformed).toEqual(base);
  expect(missingRequired).toEqual(base);
  expect(absentProject).toEqual(base);
  expect(malformedChat).toEqual(base);
  expect(mismatchedNestedProject).toEqual(base);
});

test("an absent archived or unarchive update never invents a local session row", () => {
  const base = navigation();
  const archived = applyLiveNavigationEvent(base, {
    type: "session.updated",
    payload: {
      session: projectSession({
        id: "session-unseen",
        projectId: "project-one",
        title: "보관됨",
        createdAt: "2026-08-08T00:01:00.000Z",
        updatedAt: "2026-08-08T00:06:00.000Z",
        archived: true,
      }),
    },
  });
  const staleUnarchive = applyLiveNavigationEvent(archived, {
    type: "session.updated",
    payload: {
      session: projectSession({
        id: "session-unseen",
        projectId: "project-one",
        title: "오래된 복원",
        createdAt: "2026-08-08T00:01:00.000Z",
        updatedAt: "2026-08-08T00:05:00.000Z",
        archived: false,
      }),
    },
  });
  const freshUnarchive = applyLiveNavigationEvent(archived, {
    type: "session.updated",
    payload: {
      session: projectSession({
        id: "session-unseen",
        projectId: "project-one",
        title: "최신 복원",
        createdAt: "2026-08-08T00:01:00.000Z",
        updatedAt: "2026-08-08T00:07:00.000Z",
        archived: false,
      }),
    },
  });
  expect(staleUnarchive.projects[0]?.sessions?.some(
    (session) => session.id === "session-unseen",
  )).toBe(false);
  expect(freshUnarchive).toEqual(staleUnarchive);
});

test("navigation refresh fences stale responses and coalesces one trailing request", async () => {
  let resolveFirst: (() => void) | undefined;
  let resolveSecond: (() => void) | undefined;
  const calls: Array<() => boolean> = [];
  let accepted = 0;
  const store = {
    getState: () => ({
      setNavigation: () => undefined,
      refreshNavigation: async (options?: { isCurrent?: () => boolean }) => {
        const isCurrent = options?.isCurrent ?? (() => true);
        calls.push(isCurrent);
        if (calls.length === 1) {
          await new Promise<void>((resolve) => { resolveFirst = resolve; });
        } else {
          await new Promise<void>((resolve) => { resolveSecond = resolve; });
        }
        if (isCurrent()) accepted += 1;
        return isCurrent();
      },
    }),
  };
  const reconciliation = createLiveNavigationReconciliation(store);
  reconciliation.requestRefresh();
  await tick();
  reconciliation.noteLiveNavigationEvent();
  reconciliation.requestRefresh();
  resolveFirst?.();
  await tick();
  await tick();
  expect(calls).toHaveLength(2);
  expect(accepted).toBe(0);
  resolveSecond?.();
  await tick();
  await tick();
  expect(accepted).toBe(1);
  reconciliation.dispose();
});

test("failed navigation refresh retries on the next live event without polling", async () => {
  let calls = 0;
  const store = {
    getState: () => ({
      setNavigation: () => undefined,
      refreshNavigation: async () => {
        calls += 1;
        return calls > 1;
      },
    }),
  };
  const reconciliation = createLiveNavigationReconciliation(store);
  reconciliation.requestRefresh();
  await tick();
  await tick();
  expect(calls).toBe(1);
  reconciliation.noteLiveNavigationEvent();
  await tick();
  await tick();
  expect(calls).toBe(2);
  reconciliation.dispose();
});

test("disposing navigation reconciliation fences a late response", async () => {
  let resolveRefresh: (() => void) | undefined;
  let accepted = false;
  const store = {
    getState: () => ({
      setNavigation: () => undefined,
      refreshNavigation: async (options?: { isCurrent?: () => boolean }) => {
        await new Promise<void>((resolve) => { resolveRefresh = resolve; });
        accepted = options?.isCurrent?.() ?? true;
        return accepted;
      },
    }),
  };
  const reconciliation = createLiveNavigationReconciliation(store);
  reconciliation.requestRefresh();
  await tick();
  reconciliation.dispose();
  resolveRefresh?.();
  await tick();
  await tick();
  expect(accepted).toBe(false);
});

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
