import { appCopy } from "@/app/copy.ts";
import type { CanonProposal } from "@/app/canonProposals.ts";

export const canonProposalCopy = () => {
  const deletion = appCopy.canon.deletion;
  const proposalCard = appCopy.canon.proposalCard;
  return {
    addDelete: deletion.addDelete,
    changeDelete: deletion.changeDelete,
    deleteEpic: deletion.action,
    deleteDetail: deletion.detail,
    draft: proposalCard.draft,
    changes: proposalCard.changes,
    cancel: proposalCard.cancel,
    add: proposalCard.add,
    apply: proposalCard.apply,
    cancelled: proposalCard.cancelled,
    superseded: proposalCard.superseded,
    stale: proposalCard.stale,
    receipt: (changes: CanonProposal["changes"]) => {
      const count = (op: string) => changes.filter(change => change.op === op).length;
      const receipts = proposalCard.receipt;
      const epics = ([
        ["epic.create", receipts.epicCreate], ["epic.edit", receipts.epicEdit],
        ["epic.move", receipts.epicMove], ["epic.delete", receipts.epicDelete],
      ] as const).flatMap(([op, format]) => {
        const amount = count(op);
        return amount ? [format(amount)] : [];
      });
      const others = ([
        ["plan.create", receipts.planCreate], ["plan.edit", receipts.planEdit],
        ["plan.reorder", receipts.planReorder], ["spec.edit", receipts.specEdit], ["project.create", receipts.projectCreate],
      ] as const).flatMap(([op, label]) => count(op) ? [label] : []);
      return [...(epics.length ? [receipts.epics(epics.join(", "))] : []), ...others].join(" · ");
    },
    open: proposalCard.open,
    name: proposalCard.name,
    currentPlan: proposalCard.currentPlan,
    project: proposalCard.project,
    newProject: proposalCard.newProject,
    target: (plan?: string, name?: string) => name ? proposalCard.target.newProject(name)
      : plan ? proposalCard.target.plan(plan) : proposalCard.target.backlog,
  };
};
