import type { Database } from "bun:sqlite";
import type { BtccPersistenceTypes, WorkLedgerCommit } from "../../../btcc/gateway-api.ts";
import type { ProjectWorkLedgerPublicationAdapter } from "../project-ledger/index.ts";
import {
  ProjectLedgerPromotionWriter,
  type ProjectLedgerBoundaryContext,
} from "./project-ledger-promotion-writer.ts";

type Transition = BtccPersistenceTypes["transition"];
type ProjectRuntime = {
  publications: ProjectWorkLedgerPublicationAdapter;
  resolveProjectRoot(projectRef: string): string;
};

export class ProjectLedgerBoundaryPreparer {
  private readonly promotions: ProjectLedgerPromotionWriter;

  constructor(private readonly db: Database, private readonly runtime?: ProjectRuntime) {
    this.promotions = new ProjectLedgerPromotionWriter(db);
  }

  async prepare(transition: Transition): Promise<ProjectLedgerBoundaryContext> {
    if (transition.kind === "submit_plan_candidate") return this.capturePlanningBase(transition);
    const commit = ledgerCommitOf(transition);
    if (!commit) return {};
    const scope = this.scopeFor(commit);
    if (scope.kind === "session") return {};
    const runtime = this.requireRuntime();
    const projectRoot = runtime.resolveProjectRoot(scope.id);
    const expectedBase = commit.mutation.kind === "install_reviewed_plan"
      ? this.planningBase(commit.mutation.product.candidate, scope.id, projectRoot)
      : await runtime.publications.observeCanonicalHead(projectRoot);
    const prepared = await runtime.publications.prepareCommit({
      projectRoot,
      expectedBase,
      commit,
    });
    return {
      preparedPublication: prepared.publication,
      projectedProgram: prepared.program,
      projectRef: scope.id,
    };
  }

  private async capturePlanningBase(
    transition: Extract<Transition, { kind: "submit_plan_candidate" }>,
  ): Promise<ProjectLedgerBoundaryContext> {
    const candidate = transition.product.candidate;
    const scope = this.loadScope(candidate.programId);
    if (scope.kind === "session") return {};
    const runtime = this.requireRuntime();
    const projectRoot = runtime.resolveProjectRoot(scope.id);
    return {
      planningBase: {
        candidateRef: candidate.ref.id,
        programId: candidate.programId,
        projectRef: scope.id,
        head: await runtime.publications.observeCanonicalHead(projectRoot),
      },
    };
  }

  private planningBase(
    candidate: Extract<WorkLedgerCommit["mutation"], {
      kind: "install_reviewed_plan";
    }>["product"]["candidate"],
    projectRef: string,
    projectRoot: string,
  ) {
    const base = this.promotions.loadPlanningBase(candidate.ref.id);
    if (!base || base.programId !== candidate.programId || base.projectRef !== projectRef) {
      throw new Error("Accepted Project Plan has no exact observed Planning base");
    }
    if (base.head.projectRoot !== projectRoot) {
      throw new Error("Project Ledger binding changed after Planning review");
    }
    return base.head;
  }

  private scopeFor(commit: WorkLedgerCommit) {
    if (commit.mutation.kind === "bind_program") {
      const scope = commit.mutation.product.authority.ledgerScope;
      return scope.kind === "project"
        ? { kind: "project" as const, id: scope.projectRef }
        : { kind: "session" as const, id: scope.sessionId };
    }
    const programId = commit.mutation.kind === "install_reviewed_plan"
      ? commit.mutation.product.candidate.programId : commit.mutation.cursor.programId;
    return this.loadScope(programId);
  }

  private loadScope(programId: string) {
    const project = this.db.query<{ project_ref: string }, [string]>(`
      SELECT project_ref FROM btcc_project_program_projections WHERE program_id = ?
    `).get(programId);
    if (project) return { kind: "project" as const, id: project.project_ref };
    const row = this.db.query<{ scope_kind: string; scope_id: string }, [string]>(`
      SELECT scope_kind, scope_id FROM btcc_programs WHERE program_id = ?
    `).get(programId);
    if (!row || (row.scope_kind !== "project" && row.scope_kind !== "session")) {
      throw new Error("BTCC Program has no valid Work Ledger scope projection");
    }
    return { kind: row.scope_kind, id: row.scope_id } as
      { kind: "project" | "session"; id: string };
  }

  private requireRuntime(): ProjectRuntime {
    if (!this.runtime) throw new Error("Project-bound BTCC work requires Project Ledger authority");
    return this.runtime;
  }
}

function ledgerCommitOf(transition: Transition): WorkLedgerCommit | null {
  return "ledgerCommit" in transition ? transition.ledgerCommit : null;
}
