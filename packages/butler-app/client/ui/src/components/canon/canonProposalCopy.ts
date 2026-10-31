import { appCopy } from "@/app/copy.ts";
export const canonProposalCopy = (ko: boolean) => ({
  deleteEpic: appCopy.canon.deletion.action,
  deleted: appCopy.canon.deletion.deleted,
  deleteDetail: appCopy.canon.deletion.detail,
  draft: ko ? "과제 초안 · 버틀러" : "Epic draft · Butler",
  changes: ko ? "변경 제안 · 버틀러" : "Changes · Butler",
  cancel: ko ? "취소" : "Cancel", add: ko ? "등록" : "Add", apply: ko ? "반영" : "Apply",
  added: ko ? "등록함" : "Added", chat: ko ? "대화로 등록함" : "Added in chat",
  cancelled: ko ? "취소함" : "Cancelled", superseded: ko ? "새 초안으로 바뀜" : "Replaced",
  stale: ko ? "이전 내용 기준" : "Out of date", record: ko ? "과제 등록함 · 버틀러" : "Epic added · Butler",
  open: ko ? "열기" : "Open", name: ko ? "이름을 입력하세요" : "Enter a name",
  currentPlan: ko ? "현재 계획" : "Current plan",
  project: ko ? "프로젝트" : "Project", newProject: ko ? "새 프로젝트" : "New project",
  target: (plan?: string, name?: string) => name ? ko ? `새 프로젝트 ‘${name}’ 만들고 과제 등록` : `Create project ‘${name}’ and add Epic`
    : plan ? ko ? `‘${plan}’에 과제 등록` : `Add Epic to ‘${plan}’` : ko ? "백로그에 과제 등록" : "Add Epic to Backlog",
});
