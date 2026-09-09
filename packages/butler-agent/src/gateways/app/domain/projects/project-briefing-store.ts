import type { Database } from "bun:sqlite";
import type { ReasoningEffort } from "../../../../integrations/providers/provider.ts";
import type { DashboardBriefingContent, DashboardBriefingView } from "../../interface/protocol/session-dashboard-contract.ts";
import { AppStoreOperationError } from "../../infrastructure/core/app-store-errors.ts";
import { PROJECT_BRIEFING_GENERATOR_VERSION, type ProjectBriefingPack } from "./project-briefing-facts.ts";
import { generateProjectBriefing, validateProjectBriefing } from "./project-briefing-generation.ts";
import { initializeProjectIntroduction } from "./project-introduction.ts";

/** A disposable read cache. Never participates in Turn/Work completion or queues. */
export class ProjectBriefingStore {
  private active: { key: string; abort: AbortController } | null = null;
  private attempted = new Set<string>();
  private closed = false;
  constructor(private readonly input: {
    db: Database; butlerData: string;
    readPack(projectId: string): Promise<{ pack: ProjectBriefingPack; reasoningEffort: ReasoningEffort }>;
    publish(projectId: string): void;
    generate?: typeof generateProjectBriefing;
  }) {}

  async read(projectId: string): Promise<DashboardBriefingView> {
    const { pack } = await this.input.readPack(projectId);
    return this.view(pack);
  }

  async request(projectId: string, revision: string, retry: boolean): Promise<DashboardBriefingView> {
    if (this.closed) throw new AppStoreOperationError(503, "briefing_unavailable", "Briefing unavailable.");
    const { pack, reasoningEffort } = await this.input.readPack(projectId);
    if (pack.revision !== revision) throw new AppStoreOperationError(409, "source_changed", "Source changed. Reload it.");
    const view = this.view(pack);
    if (view.status === "ready" || view.status === "generating" || !pack.sources.length) return view;
    if (this.active || (this.attempted.has(pack.revision) && !retry)) return { ...view, status: "unavailable" };
    if (this.attempted.size >= 64) this.attempted.delete(this.attempted.values().next().value!);
    this.attempted.add(pack.revision);
    const job = { key: pack.revision, abort: new AbortController() };
    this.active = job;
    const preferences = this.input.db.query<{ dashboard_preferences_revision: number }, [string]>(
      "SELECT dashboard_preferences_revision FROM projects WHERE id = ?",
    ).get(projectId);
    void this.finish(pack, reasoningEffort, job, preferences?.dashboard_preferences_revision ?? 0);
    return { ...view, status: "generating" };
  }

  close() { this.closed = true; this.active?.abort.abort(); this.active = null; }

  private view(pack: ProjectBriefingPack): DashboardBriefingView {
    const base = { sourceRevision: pack.revision, language: pack.language, coverage: pack.coverage,
      sources: pack.sources, candidates: pack.candidates };
    const cached = this.input.db.query<{ content_json: string; generated_at: string; source_digest: string }, [string, string, string]>(
      "SELECT content_json, generated_at, source_digest FROM project_dashboard_briefing_cache WHERE project_id = ? AND response_language = ? AND generator_version = ?",
    ).get(pack.projectId, pack.language, PROJECT_BRIEFING_GENERATOR_VERSION);
    if (cached?.source_digest === pack.revision) {
      try { return { ...base, status: "ready", content: validateProjectBriefing(cached.content_json, pack), generatedAt: cached.generated_at }; }
      catch { /* Derived cache corruption must not break canonical facts. */ }
    }
    return { ...base, status: !pack.sources.length ? "unavailable" : this.active?.key === pack.revision ? "generating"
      : this.attempted.has(pack.revision) ? "unavailable" : "needed" };
  }

  private async finish(pack: ProjectBriefingPack, reasoningEffort: ReasoningEffort, job: { key: string; abort: AbortController }, preferencesRevision: number) {
    try {
      const content: DashboardBriefingContent = await (this.input.generate ?? generateProjectBriefing)({
        pack, reasoningEffort, butlerData: this.input.butlerData, signal: job.abort.signal,
      });
      if (this.closed || job.abort.signal.aborted) return;
      validateProjectBriefing(JSON.stringify(content), pack);
      const current = await this.input.readPack(pack.projectId);
      if (this.closed || current.pack.revision !== pack.revision) return;
      let cachePack = pack;
      if (!pack.description && initializeProjectIntroduction(this.input.db, pack.projectId, preferencesRevision, content.introduction)) {
        const refreshed = await this.input.readPack(pack.projectId);
        cachePack = refreshed.pack;
        // Only reuse this answer for our own introduction write, never for changed project facts.
        if (refreshed.reasoningEffort !== reasoningEffort || cachePack.description !== content.introduction ||
            JSON.stringify([cachePack.binding, cachePack.facts, cachePack.sources, cachePack.candidates, cachePack.coverage, cachePack.language, cachePack.model]) !==
            JSON.stringify([pack.binding, pack.facts, pack.sources, pack.candidates, pack.coverage, pack.language, pack.model])) return;
      }
      if (this.closed || job.abort.signal.aborted) return;
      this.input.db.query(`INSERT INTO project_dashboard_briefing_cache
        (project_id, binding_revision, source_digest, response_language, generator_version, content_json, generated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, response_language) DO UPDATE SET
        binding_revision=excluded.binding_revision, source_digest=excluded.source_digest,
        generator_version=excluded.generator_version, content_json=excluded.content_json, generated_at=excluded.generated_at
      `).run(cachePack.projectId, cachePack.binding, cachePack.revision, cachePack.language, PROJECT_BRIEFING_GENERATOR_VERSION, JSON.stringify(content), new Date().toISOString());
    } catch { /* Safe generic UI state; provider errors/prompts are never published. No automatic retry loop. */ }
    finally {
      if (this.active === job) this.active = null;
      if (!this.closed) this.input.publish(pack.projectId);
    }
  }
}
