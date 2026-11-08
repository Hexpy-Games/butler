import { appCopy } from "@/app/copy.ts";
import type { CanonProposal } from "@/app/canonProposals.ts";
export const canonProposalCopy = (ko: boolean) => ({
  addDelete: appCopy.canon.deletion.addDelete,
  changeDelete: appCopy.canon.deletion.changeDelete,
  deleteEpic: appCopy.canon.deletion.action,
  deleteDetail: appCopy.canon.deletion.detail,
  draft: ko ? "과제 초안 · 버틀러" : "Epic draft · Butler",
  changes: ko ? "변경 제안 · 버틀러" : "Changes · Butler",
  cancel: ko ? "취소" : "Cancel", add: ko ? "등록" : "Add", apply: ko ? "반영" : "Apply",
  cancelled: ko ? "취소함" : "Cancelled", superseded: ko ? "새 초안으로 바뀜" : "Replaced",
  stale: ko ? "이전 내용 기준" : "Out of date",
  receipt: (changes: CanonProposal["changes"]) => {
    const count = (op: string) => changes.filter(change => change.op === op).length;
    const epics = ([["epic.create", "등록", "added"], ["epic.edit", "변경", "changed"], ["epic.move", "이동", "moved"], ["epic.delete", "삭제", "deleted"]] as const)
      .flatMap(([op, verb, en]) => count(op) ? [ko ? `${count(op)}개 ${verb}` : `${count(op)} ${en}`] : []);
    const others = ([["plan.create", "계획 등록", "Plan added"], ["plan.edit", "계획 변경", "Plan changed"], ["plan.reorder", "순서 변경", "Reordered"], ["spec.edit", "명세 변경", "Spec changed"], ["project.create", "프로젝트 생성", "Project created"]] as const)
      .flatMap(([op, label, en]) => count(op) ? [ko ? label : en] : []);
    return [...epics.length ? [ko ? `과제 ${epics.join(", ")}` : `Epics: ${epics.join(", ")}`] : [], ...others].join(" · ");
  },
  open: ko ? "열기" : "Open", name: ko ? "이름을 입력하세요" : "Enter a name",
  currentPlan: ko ? "현재 계획" : "Current plan",
  project: ko ? "프로젝트" : "Project", newProject: ko ? "새 프로젝트" : "New project",
  target: (plan?: string, name?: string) => name ? ko ? `새 프로젝트 ‘${name}’ 만들고 과제 등록` : `Create project ‘${name}’ and add Epic`
    : plan ? ko ? `‘${plan}’에 과제 등록` : `Add Epic to ‘${plan}’` : ko ? "백로그에 과제 등록" : "Add Epic to Backlog",
});
