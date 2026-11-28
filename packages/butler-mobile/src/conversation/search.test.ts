// test-category: pure-logic
import { expect, test } from "bun:test";
import { chatHits } from "./search";

test("chatHits keeps conversation order and maps titles and subtitles", () => {
  expect(chatHits([
    { id: "chat", kind: "chat", title: "Planning", subtitle: "Work / Notes" },
    { id: "project", kind: "project", title: "Work" },
    { id: "project-chat", kind: "project_session", title: "Project notes", subtitle: "Project chat" },
    { id: "group", kind: "group", title: "Notes" },
    { id: "general", kind: "chat", title: "General", subtitle: "Chat" },
    { id: "schedule", kind: "automation", title: "Weekly notes" },
    { id: "untitled", kind: "chat", title: " " },
  ], { chat: "대화", project_session: "프로젝트 대화" }, "제목 없음", "일반")).toEqual([
    { id: "chat", kind: "chat", title: "Planning", subtitle: "Work / Notes" },
    { id: "project-chat", kind: "project_session", title: "Project notes", subtitle: "프로젝트 대화" },
    { id: "general", kind: "chat", title: "일반", subtitle: "대화" },
    { id: "untitled", kind: "chat", title: "제목 없음", subtitle: "대화" },
  ]);
});
